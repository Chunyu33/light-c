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
use super::tools::{
    AiToolCall, TOOL_PROPOSE_DELETE, TOOL_READ_ITEMS, TOOL_READ_ITEM_DETAIL, TOOL_SELECT_ITEMS,
};
use std::collections::BTreeMap;

/// 一次工具调用的分片累积。
///
/// 流式下工具参数是**分多次吐出来的半个 JSON**，必须按索引拼回去：
/// OpenAI 给 `delta.tool_calls[{index, id?, function:{name?, arguments?}}]`，
/// 只有第一片带 id 与 name；Anthropic 则是 `content_block_start`（带 id/name）
/// 加一串 `input_json_delta`（带 partial_json）。
#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// SSE 数据块的增量解析器。
/// 用法：每收到一块网络数据就 `push`，取出返回的增量文本；流结束时调用 `finish`。
pub struct StreamDecoder {
    protocol: AiProtocol,
    /// 尚未构成完整行的残留数据
    buffer: String,
    /// 服务端已宣告结束（data: [DONE] 之类）
    pub finished: bool,
    /// 累积中的工具调用，按分片索引排序保证顺序稳定
    partial_tools: BTreeMap<usize, PartialToolCall>,
}

impl StreamDecoder {
    pub fn new(protocol: AiProtocol) -> Self {
        Self {
            protocol,
            buffer: String::new(),
            finished: false,
            partial_tools: BTreeMap::new(),
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

    /// 把这一片里的工具增量累积下来（如果有）。必须在取正文之前调用。
    fn record_tool_fragments(&mut self, value: &serde_json::Value) {
        match self.protocol {
            AiProtocol::OpenAi => {
                // delta.tool_calls[]：按 index 累积，只有首片带 id 与 name
                let Some(calls) = value
                    .get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("delta"))
                    .and_then(|delta| delta.get("tool_calls"))
                    .and_then(|calls| calls.as_array())
                else {
                    return;
                };
                for fragment in calls {
                    let index = fragment.get("index").and_then(|item| item.as_u64()).unwrap_or(0) as usize;
                    let entry = self.partial_tools.entry(index).or_default();
                    if let Some(id) = fragment.get("id").and_then(|item| item.as_str()) {
                        entry.id = id.to_string();
                    }
                    if let Some(function) = fragment.get("function") {
                        if let Some(name) = function.get("name").and_then(|item| item.as_str()) {
                            entry.name.push_str(name);
                        }
                        if let Some(args) = function.get("arguments").and_then(|item| item.as_str()) {
                            entry.arguments.push_str(args);
                        }
                    }
                }
            }
            AiProtocol::Anthropic => {
                // content_block_start 给 id/name，随后一串 input_json_delta 给参数片段
                let index = value
                    .get("index")
                    .and_then(|item| item.as_u64())
                    .unwrap_or(0) as usize;
                if value.get("type").and_then(|item| item.as_str()) == Some("content_block_start") {
                    if let Some(block) = value.get("content_block") {
                        if block.get("type").and_then(|item| item.as_str()) == Some("tool_use") {
                            let entry = self.partial_tools.entry(index).or_default();
                            if let Some(id) = block.get("id").and_then(|item| item.as_str()) {
                                entry.id = id.to_string();
                            }
                            if let Some(name) = block.get("name").and_then(|item| item.as_str()) {
                                entry.name = name.to_string();
                            }
                        }
                    }
                } else if let Some(delta) = value.get("delta") {
                    if delta.get("type").and_then(|item| item.as_str()) == Some("input_json_delta") {
                        if let Some(partial) = delta.get("partial_json").and_then(|item| item.as_str()) {
                            self.partial_tools.entry(index).or_default().arguments.push_str(partial);
                        }
                    }
                }
            }
        }
    }

    /// 取出累积完成的工具调用。参数解析失败时给空对象 ——
    /// 调用方据此当作"没有 id"，不会拿它去做任何操作。
    pub fn take_tool_calls(&mut self) -> Vec<AiToolCall> {
        std::mem::take(&mut self.partial_tools)
            .into_iter()
            .filter(|(_, call)| {
                !call.name.is_empty()
                    && (call.name == TOOL_SELECT_ITEMS
                        || call.name == TOOL_PROPOSE_DELETE
                        || call.name == TOOL_READ_ITEMS
                        || call.name == TOOL_READ_ITEM_DETAIL)
            })
            .map(|(_, call)| AiToolCall {
                call_id: call.id,
                name: call.name,
                arguments: serde_json::from_str(&call.arguments).unwrap_or_else(|_| serde_json::json!({})),
            })
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

        // 先把这一片里的工具增量累积下来，再取正文 —— 两者可能同时出现
        self.record_tool_fragments(&value);

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
    fn openai_tool_call_fragments_are_reassembled_by_index() {
        // 真实流式下参数是分片来的，而且只有首片带 id/name —— 这是最容易拼错的地方
        let mut decoder = StreamDecoder::new(AiProtocol::OpenAi);
        assert!(decoder
            .push("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"select_items\",\"arguments\":\"\"}}]}}]}\n")
            .is_empty());
        decoder.push("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"ids\\\":[\\\"Re\"}}]}}]}\n");
        decoder.push("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"cycleBin\\\"]}\"}}]}}]}\n");
        decoder.push("data: [DONE]\n");

        let calls = decoder.take_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "select_items");
        assert_eq!(calls[0].call_id, "call_1");
        // 拼回来的参数必须能解析出 id
        assert_eq!(
            calls[0].arguments.get("ids").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(1)
        );
    }

    #[test]
    fn anthropic_partial_json_is_reassembled() {
        let mut decoder = StreamDecoder::new(AiProtocol::Anthropic);
        decoder.push("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"propose_delete\"}}\n");
        decoder.push("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"ids\\\":\"}}\n");
        decoder.push("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"[\\\"WindowsTemp\\\"]}\"}}\n");

        let calls = decoder.take_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "propose_delete");
        assert_eq!(
            calls[0].arguments.get("ids").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()),
            Some("WindowsTemp")
        );
    }

    #[test]
    fn unknown_tool_names_are_dropped_in_stream() {
        // 只认声明过的两个工具，别的一律丢弃 —— 免得出现"没声明的工具被执行"
        let mut decoder = StreamDecoder::new(AiProtocol::OpenAi);
        decoder.push("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"x\",\"function\":{\"name\":\"run_shell\",\"arguments\":\"{}\"}}]}}]}\n");
        assert!(decoder.take_tool_calls().is_empty());
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
