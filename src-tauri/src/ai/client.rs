// ============================================================================
// AI 客户端：发一次对话、拉模型列表
//
// 两种协议在这里归一 —— 上层只提交 AiChatRequest，不关心底层是 DeepSeek 还是
// Claude。鉴权头、请求体形状、响应解析、超时都集中在本文件，
// 避免这些细节散落到命令层或配置层。
// ============================================================================

use super::config::read_config;
use super::presets::{find_preset, AiProtocol};
use super::stream::StreamDecoder;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 对话超时：LLM 首字延迟可能较久，给宽松一些。
const CHAT_TIMEOUT_SECS: u64 = 60;
/// 拉模型列表是轻量请求，超时收紧，避免设置页"测试连接"卡太久。
const MODELS_TIMEOUT_SECS: u64 = 20;
/// 流式对话的整段超时。reqwest 的 timeout 覆盖"直到响应体读完"，
/// 用对话那 60 秒会把长回答从中间切断，所以流式单独放宽。
const STREAM_TIMEOUT_SECS: u64 = 300;
/// Anthropic 要求显式给 max_tokens，这里给一个够用的默认值。
const ANTHROPIC_MAX_TOKENS: u32 = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub messages: Vec<AiChatMessage>,
    /// 单次调用覆盖模型；不填则用设置里保存的
    #[serde(default)]
    pub model: Option<String>,
    /// 采样温度；不填用服务端默认
    #[serde(default)]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatReply {
    pub content: String,
    pub model: String,
}

/// 拼接接口地址，容忍 base_url 带或不带结尾斜杠。
fn join_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    format!("{}/{}", trimmed, suffix)
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| format!("创建网络请求客户端失败: {}", error))
}

/// 取"当前生效"的连接信息：预设里的协议 + 配置里的地址/密钥/模型。
/// 地址留空时回落到预设默认值，用户只填密钥也能用。
fn resolve_connection() -> Result<(AiProtocol, String, String, String), String> {
    let stored = read_config();
    let preset = find_preset(&stored.provider_id);

    let api_key = stored.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("还没有配置 API Key，请到「设置 - AI 助手」里填写。".to_string());
    }

    let base_url = if stored.base_url.trim().is_empty() {
        preset.base_url.to_string()
    } else {
        stored.base_url.trim().to_string()
    };
    if base_url.is_empty() {
        return Err("还没有填写接口地址，请到「设置 - AI 助手」里填写。".to_string());
    }

    let model = if stored.model.trim().is_empty() {
        preset.default_model.to_string()
    } else {
        stored.model.trim().to_string()
    };

    Ok((preset.protocol, base_url, api_key, model))
}

// ---------------------------------------------------------------------------
// 请求体构造（抽成纯函数，便于单测；不依赖网络）
// ---------------------------------------------------------------------------

/// OpenAI 兼容协议：system 与 user/assistant 混在同一个 messages 数组里。
fn build_openai_body(request: &AiChatRequest, model: &str) -> serde_json::Value {
    let messages: Vec<serde_json::Value> = request
        .messages
        .iter()
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": message.content,
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    body
}

/// Anthropic 协议：**system 不在 messages 里**，要提到顶层单独传；
/// 而且 max_tokens 是必填项。
fn build_anthropic_body(request: &AiChatRequest, model: &str) -> serde_json::Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut messages: Vec<serde_json::Value> = Vec::new();

    for message in &request.messages {
        if message.role == "system" {
            system_parts.push(message.content.clone());
            continue;
        }
        messages.push(serde_json::json!({
            "role": message.role,
            "content": message.content,
        }));
    }

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "messages": messages,
    });
    if !system_parts.is_empty() {
        body["system"] = serde_json::json!(system_parts.join("\n\n"));
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    body
}

// ---------------------------------------------------------------------------
// 响应解析（同样是纯函数）
// ---------------------------------------------------------------------------

/// OpenAI 兼容：choices[0].message.content
fn parse_openai_reply(value: &serde_json::Value) -> Option<String> {
    value
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(|text| text.to_string())
}

/// Anthropic：content 是数组，取其中 type == "text" 的部分拼起来。
fn parse_anthropic_reply(value: &serde_json::Value) -> Option<String> {
    let blocks = value.get("content")?.as_array()?;
    let text: String = blocks
        .iter()
        .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 模型列表：两种协议的返回都是 `{ "data": [ { "id": ... } ] }`，可以共用。
fn parse_model_ids(value: &serde_json::Value) -> Vec<String> {
    value
        .get("data")
        .and_then(|data| data.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
                .map(|id| id.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// 把服务端返回的错误体摘成人话，避免直接把一大坨 JSON 甩给用户。
fn describe_http_error(status: u16, body: &str) -> String {
    let brief: String = body.chars().take(300).collect();
    match status {
        401 | 403 => format!("鉴权失败（{}），请检查 API Key 是否正确、是否已开通该模型。{}", status, brief),
        404 => format!("接口地址不对（404），请检查「接口地址」是否填成了正确的服务商地址。{}", brief),
        429 => format!("请求太频繁或额度不足（429）。{}", brief),
        _ => format!("请求失败（{}）：{}", status, brief),
    }
}

// ---------------------------------------------------------------------------
// 对外能力
// ---------------------------------------------------------------------------

/// 发一次对话（非流式）。流式输出属于后续阶段，这里先保证"能问能答"。
pub async fn chat_once(request: AiChatRequest) -> Result<AiChatReply, String> {
    let (protocol, base_url, api_key, model) = resolve_connection()?;
    let model = request.model.clone().unwrap_or(model);
    if model.trim().is_empty() {
        return Err("还没有选择模型，请在设置里拉取模型列表后选择，或手动填写模型名。".to_string());
    }

    let client = http_client(CHAT_TIMEOUT_SECS)?;
    let response = match protocol {
        AiProtocol::OpenAi => {
            let body = build_openai_body(&request, &model);
            client
                .post(join_url(&base_url, "/chat/completions"))
                .bearer_auth(&api_key)
                .json(&body)
                .send()
                .await
        }
        AiProtocol::Anthropic => {
            let body = build_anthropic_body(&request, &model);
            client
                .post(join_url(&base_url, "/v1/messages"))
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
        }
    }
    .map_err(|error| format!("网络请求失败: {}", error))?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取响应内容失败: {}", error))?;
    if !(200..300).contains(&status) {
        return Err(describe_http_error(status, &text));
    }

    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("响应不是合法 JSON: {}", error))?;
    let content = match protocol {
        AiProtocol::OpenAi => parse_openai_reply(&value),
        AiProtocol::Anthropic => parse_anthropic_reply(&value),
    }
    .ok_or_else(|| format!("响应里没有找到回复正文，可能模型不支持该调用方式。原始响应片段: {}", text.chars().take(300).collect::<String>()))?;

    Ok(AiChatReply { content, model })
}

/// 拉取可用模型列表。设置页的「测试连接」用的就是它 ——
/// 能成功拉到列表，说明地址、密钥、网络三者都没问题。
pub async fn fetch_models() -> Result<Vec<String>, String> {
    let (protocol, base_url, api_key, _) = resolve_connection()?;
    let client = http_client(MODELS_TIMEOUT_SECS)?;

    let path = match protocol {
        AiProtocol::OpenAi => "/models",
        AiProtocol::Anthropic => "/v1/models",
    };
    let mut request = client.get(join_url(&base_url, path));
    request = match protocol {
        AiProtocol::OpenAi => request.bearer_auth(&api_key),
        AiProtocol::Anthropic => request
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01"),
    };

    let response = request
        .send()
        .await
        .map_err(|error| format!("网络请求失败: {}", error))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取响应内容失败: {}", error))?;
    if !(200..300).contains(&status) {
        return Err(describe_http_error(status, &text));
    }

    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("响应不是合法 JSON: {}", error))?;
    let mut ids = parse_model_ids(&value);
    ids.sort();
    if ids.is_empty() {
        return Err("连上了，但这个服务商没有返回模型列表，请在设置里手动填写模型名。".to_string());
    }
    Ok(ids)
}

/// 流式对话：每收到一段增量就调用一次 `on_delta`，最后返回完整正文。
///
/// 用 `reqwest::Response::chunk()` 增量读取 —— 它不需要额外依赖，也不要求开 feature
/// （`bytes_stream()` 会引入 futures-util）。SSE 的拆包与协议差异交给 stream.rs。
pub async fn chat_stream<F>(request: AiChatRequest, mut on_delta: F) -> Result<AiChatReply, String>
where
    F: FnMut(&str),
{
    let (protocol, base_url, api_key, model) = resolve_connection()?;
    let model = request.model.clone().unwrap_or(model);
    if model.trim().is_empty() {
        return Err("还没有选择模型，请在设置里拉取模型列表后选择，或手动填写模型名。".to_string());
    }

    let client = http_client(STREAM_TIMEOUT_SECS)?;
    // 复用非流式的请求构造，只把 stream 打开：两种协议的请求体本来就只有这一处差异，
    // 没必要为了流式再抄一份构造函数（抄一份就多一处会忘记同步的地方）。
    let mut body = match protocol {
        AiProtocol::OpenAi => build_openai_body(&request, &model),
        AiProtocol::Anthropic => build_anthropic_body(&request, &model),
    };
    body["stream"] = serde_json::json!(true);

    let send = match protocol {
        AiProtocol::OpenAi => {
            client
                .post(join_url(&base_url, "/chat/completions"))
                .bearer_auth(&api_key)
                .json(&body)
                .send()
                .await
        }
        AiProtocol::Anthropic => {
            client
                .post(join_url(&base_url, "/v1/messages"))
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
        }
    };
    let mut response = send.map_err(|error| format!("网络请求失败: {}", error))?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = response.text().await.unwrap_or_default();
        return Err(describe_http_error(status, &text));
    }

    // 边收边发：用户能立刻看到字出来，而不是等整段返回
    let mut decoder = StreamDecoder::new(protocol);
    let mut full = String::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取流式响应失败: {}", error))?
    {
        let text = String::from_utf8_lossy(&chunk);
        for delta in decoder.push(&text) {
            full.push_str(&delta);
            on_delta(&delta);
        }
        if decoder.finished {
            break;
        }
    }
    for delta in decoder.finish() {
        full.push_str(&delta);
        on_delta(&delta);
    }

    if full.trim().is_empty() {
        return Err("服务端没有返回任何内容，请确认所选模型支持流式输出。".to_string());
    }
    Ok(AiChatReply { content: full, model })
}

// ---------------------------------------------------------------------------
// 单元测试：只覆盖纯函数（不发网络请求）。
// 请求体形状是这里最容易出错的地方 —— 尤其 Anthropic 的 system 必须提到顶层。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> AiChatRequest {
        AiChatRequest {
            messages: vec![
                AiChatMessage {
                    role: "system".to_string(),
                    content: "你是助手".to_string(),
                },
                AiChatMessage {
                    role: "user".to_string(),
                    content: "你好".to_string(),
                },
            ],
            model: None,
            temperature: Some(0.3),
        }
    }

    #[test]
    fn joins_url_with_or_without_trailing_slash() {
        assert_eq!(
            join_url("https://api.deepseek.com/v1", "/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_url("https://api.deepseek.com/v1/", "/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn openai_body_keeps_system_inside_messages() {
        let body = build_openai_body(&sample_request(), "deepseek-chat");
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], false);
        let messages = body["messages"].as_array().expect("messages 应为数组");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert!((body["temperature"].as_f64().unwrap() - 0.3).abs() < 1e-6);
    }

    #[test]
    fn anthropic_body_hoists_system_and_sets_max_tokens() {
        let body = build_anthropic_body(&sample_request(), "claude-sonnet-4-5");
        // system 必须提到顶层，**不能**留在 messages 里（否则 Anthropic 直接报错）
        assert_eq!(body["system"], "你是助手");
        let messages = body["messages"].as_array().expect("messages 应为数组");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        assert!(body["max_tokens"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn parses_openai_reply() {
        let value = serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "你好呀" } }]
        });
        assert_eq!(parse_openai_reply(&value), Some("你好呀".to_string()));
    }

    #[test]
    fn parses_anthropic_reply_and_ignores_non_text_blocks() {
        let value = serde_json::json!({
            "content": [
                { "type": "thinking", "thinking": "内部推理" },
                { "type": "text", "text": "前半" },
                { "type": "text", "text": "后半" }
            ]
        });
        assert_eq!(parse_anthropic_reply(&value), Some("前半后半".to_string()));
    }

    #[test]
    fn parses_model_ids_from_data_array() {
        let value = serde_json::json!({
            "data": [{ "id": "b-model" }, { "id": "a-model" }, { "object": "x" }]
        });
        assert_eq!(parse_model_ids(&value), vec!["b-model", "a-model"]);
    }
}
