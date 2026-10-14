// ============================================================================
// 流式响应的增量解析
//
// 服务端返回的是 SSE（Server-Sent Events），两个坑必须处理：
//
// 1. **数据包边界与行边界不对齐**。网络按块到达，一个 `data: {...}` 可能被切成两半，
//    也可能一次来好几条。所以必须自己缓冲，只处理"完整的行"，剩下的留到下一块。
// 2. **两种协议的增量格式不同**：
//      OpenAI 兼容：data: {"choices":[{"delta":{"content":"文字"}}]}
//      Anthropic：  data: {"type":"content_block_delta","delta":{"text":"文字"}}
//    结束标记也不同，由各自的解析函数负责识别。
//
// 这里全部是纯函数，不碰网络 —— 便于单测钉住这两个坑。
// ============================================================================

use super::presets::AiProtocol;

/// SSE 数据块的增量解析器。
/// 用法：每收到一块网络数据就 `push`，取出返回的增量文本；流结束时调用 `finish`。
pub struct StreamDecoder {
    protocol: AiProtocol,
    /// 尚未构成完整行的残留数据
    buffer: String,
    /// 服务端已宣告结束（data: [DONE] 之类）
    pub finished: bool,
}

impl StreamDecoder {
    pub fn new(protocol: AiProtocol) -> Self {
        Self {
            protocol,
            buffer: String::new(),
            finished: false,
        }
    }

    /// 喂入一段原始文本，返回本次能解析出的全部增量文本片段。
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut deltas = Vec::new();

        // 只处理完整的行；最后一段（可能只有半行）留在 buffer 里等下一块
        while let Some(index) = self.buffer.find('\n') {
            let line = self.buffer[..index].trim_end_matches('\r').to_string();
            self.buffer.drain(..=index);

            if let Some(delta) = self.parse_line(&line) {
                deltas.push(delta);
            }
        }
        deltas
    }

    /// 流结束：把缓冲区里可能残留的最后一行也处理掉。
    pub fn finish(&mut self) -> Vec<String> {
        if self.buffer.trim().is_empty() {
            return Vec::new();
        }
        let line = std::mem::take(&mut self.buffer);
        self.parse_line(line.trim_end_matches('\r'))
            .into_iter()
            .collect()
    }

    /// 解析单行 SSE。返回 Some 表示这一行贡献了一段正文。
    fn parse_line(&mut self, line: &str) -> Option<String> {
        let trimmed = line.trim();
        // 空行、注释行（:heartbeat 之类）、event: 行都不含正文
        if trimmed.is_empty() || trimmed.starts_with(':') || trimmed.starts_with("event:") {
            return None;
        }

        let payload = trimmed.strip_prefix("data:")?.trim();
        if payload == "[DONE]" {
            self.finished = true;
            return None;
        }

        let value: serde_json::Value = serde_json::from_str(payload).ok()?;

        // 服务端有时会把错误放进流里，这时也要能识别出来，否则界面会"卡住不出字"
        if let Some(error) = extract_stream_error(&value) {
            self.finished = true;
            return Some(format!("\n[服务端返回错误] {}", error));
        }

        match self.protocol {
            AiProtocol::OpenAi => parse_openai_delta(&value),
            AiProtocol::Anthropic => parse_anthropic_delta(&value),
        }
    }
}

/// OpenAI 兼容：choices[0].delta.content
fn parse_openai_delta(value: &serde_json::Value) -> Option<String> {
    let text = value.get("choices")?.get(0)?.get("delta")?.get("content")?.as_str()?;
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Anthropic：{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
fn parse_anthropic_delta(value: &serde_json::Value) -> Option<String> {
    let text = value.get("delta")?.get("text")?.as_str()?;
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 从流式分片里提取错误信息（两家都可能把 error 放在任何一条分片里）。
fn extract_stream_error(value: &serde_json::Value) -> Option<String> {
    let error = value.get("error")?;
    if let Some(message) = error.get("message").and_then(|item| item.as_str()) {
        return Some(message.to_string());
    }
    error.as_str().map(|text| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_deltas_are_extracted_and_done_is_detected() {
        let mut decoder = StreamDecoder::new(AiProtocol::OpenAi);
        let deltas = decoder.push(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\
             data: [DONE]\n",
        );
        assert_eq!(deltas, vec!["你".to_string(), "好".to_string()]);
        assert!(decoder.finished);
    }

    #[test]
    fn partial_lines_are_buffered_until_complete() {
        let mut decoder = StreamDecoder::new(AiProtocol::OpenAi);
        // 这一块故意把一行切成两半：不应该解析出任何内容
        let first = decoder.push("data: {\"choices\":[{\"delta\":{\"cont");
        assert!(first.is_empty(), "半行不该产出增量");
        // 补全后才产出
        let second = decoder.push("ent\":\"完整\"}}]}\n");
        assert_eq!(second, vec!["完整".to_string()]);
    }

    #[test]
    fn anthropic_delta_uses_nested_text_field() {
        let mut decoder = StreamDecoder::new(AiProtocol::Anthropic);
        let deltas = decoder.push(
            "event: content_block_delta\n\
             data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"嗨\"}}\n",
        );
        assert_eq!(deltas, vec!["嗨".to_string()]);
    }

    #[test]
    fn error_inside_stream_is_surfaced() {
        let mut decoder = StreamDecoder::new(AiProtocol::OpenAi);
        let deltas = decoder.push("data: {\"error\":{\"message\":\"额度不足\"}}\n");
        assert_eq!(deltas.len(), 1);
        assert!(deltas[0].contains("额度不足"));
        assert!(decoder.finished);
    }

    #[test]
    fn finish_flushes_a_trailing_line_without_newline() {
        let mut decoder = StreamDecoder::new(AiProtocol::OpenAi);
        assert!(decoder.push("data: {\"choices\":[{\"delta\":{\"content\":\"尾\"}}]}").is_empty());
        assert_eq!(decoder.finish(), vec!["尾".to_string()]);
    }
}
