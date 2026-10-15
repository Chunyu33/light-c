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
use super::tools::{
    anthropic_tools, extract_inline_tool_calls, openai_tools, parse_tool_calls, AiToolCall,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
/// 对话超时：LLM 首字延迟可能较久，给宽松一些。
const CHAT_TIMEOUT_SECS: u64 = 60;
/// 拉模型列表是轻量请求，超时收紧，避免设置页"测试连接"卡太久。
const MODELS_TIMEOUT_SECS: u64 = 20;
/// 流式对话的整段超时（兜底上限）。reqwest 的 timeout 覆盖"直到响应体读完"，
/// 用对话那 60 秒会把长回答从中间切断，所以流式单独放宽。
/// ⚠️ 真正判断"卡住"的是下面的**空闲超时**，这里只是防止连接永不结束。
const STREAM_TIMEOUT_SECS: u64 = 600;
/// 流式的**空闲超时**：这么久没有收到任何新数据就判定卡住并断开。
/// 30 秒足够覆盖服务商的首字延迟（推理模型偶尔要十几秒），又不会让用户干等。
const STREAM_IDLE_TIMEOUT_SECS: u64 = 30;
/// 上面那个值的 Duration 形式（循环里每次都要用，不必反复转）
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS);
/// Anthropic 要求显式给 max_tokens，这里给一个够用的默认值。
const ANTHROPIC_MAX_TOKENS: u32 = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
    /// 图片附件。为空时按纯文本发送 —— **与加入此功能之前的请求完全一致**。
    ///
    /// 为什么不把 base64 直接塞进 content：两种协议都要求图文**分开作为分片**，
    /// 而且前端还要显示缩略图、落盘时替换成占位符，分开处理反而更简单。
    #[serde(default)]
    pub images: Vec<AiImage>,
}

/// 一条消息里的图片附件。前端负责**先压缩再传** ——
/// 原图 base64 会让每一轮请求都膨胀好几 MB（历史每轮都要重发）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiImage {
    /// 例如 image/jpeg
    pub media_type: String,
    /// 不带 `data:` 前缀的纯 base64
    pub data_base64: String,
}

/// OpenAI 兼容协议的内容分片：纯文本时直接用字符串，带图时用 `image_url` 分片。
fn build_openai_content(message: &AiChatMessage) -> serde_json::Value {
    if message.images.is_empty() {
        return serde_json::json!(message.content);
    }
    let mut parts: Vec<serde_json::Value> = Vec::new();
    if !message.content.trim().is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": message.content }));
    }
    for image in &message.images {
        parts.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", image.media_type, image.data_base64) },
        }));
    }
    serde_json::json!(parts)
}

/// Anthropic 协议的内容分片：图片用 `source.base64`，不是 data URI。
fn build_anthropic_content(message: &AiChatMessage) -> serde_json::Value {
    if message.images.is_empty() {
        return serde_json::json!(message.content);
    }
    let mut parts: Vec<serde_json::Value> = Vec::new();
    if !message.content.trim().is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": message.content }));
    }
    for image in &message.images {
        parts.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.media_type,
                "data": image.data_base64,
            },
        }));
    }
    serde_json::json!(parts)
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
    /// 本次允许使用的工具名。
    /// **由前端按「该模块登记了哪些动作」决定** —— 只分析不删除的模块不会传
    /// propose_delete，于是模型连这个工具都看不到，也就无从提议删除。
    #[serde(default)]
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatReply {
    pub content: String,
    pub model: String,
    /// 模型请求调用的工具。有值时 content 通常为空 —— 它不是"回复"，而是一个动作意图。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<AiToolCall>,
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
/// 把档案里配置的"思考强度"挂到请求体上。
///
/// ⚠️ **无法自动探测哪些模型支持**：`/models` 只返回模型名，不含能力信息。
/// 所以做法是"用户设了才发"，并且只走 OpenAI 兼容协议 —— 那是国内多数服务商
/// 采用的字段名；Anthropic 的思考是 `thinking` 对象、形状完全不同，不在这里猜测。
///
/// 不支持的模型收到这个字段：有的直接忽略，有的会报错。后者会在界面上看到原文，
/// 用户把这一项改回"默认"即可 —— 这比替他猜要不要发要可靠。
fn attach_reasoning_effort(body: &mut serde_json::Value, protocol: AiProtocol) {
    if protocol != AiProtocol::OpenAi {
        return;
    }
    let Some(effort) = read_config()
        .active_profile()
        .map(|profile| profile.reasoning_effort.trim().to_string())
    else {
        return;
    };
    if effort.is_empty() {
        return;
    }
    body["reasoning_effort"] = serde_json::json!(effort);
}

fn resolve_connection() -> Result<(AiProtocol, String, String, String), String> {
    let stored = read_config();
    // 一切以"当前档案"为准：用户切了服务商，下一次调用就该换一套
    let profile = stored
        .active_profile()
        .ok_or_else(|| "还没有添加 AI 服务商，请到「设置 - AI 助手」里添加。".to_string())?;
    let preset = find_preset(&profile.provider_id);

    let api_key = profile.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("当前服务商还没有填写 API Key，请到「设置 - AI 助手」里填写。".to_string());
    }

    let base_url = if profile.base_url.trim().is_empty() {
        preset.base_url.to_string()
    } else {
        profile.base_url.trim().to_string()
    };
    if base_url.is_empty() {
        return Err("还没有填写接口地址，请到「设置 - AI 助手」里填写。".to_string());
    }

    let model = if profile.model.trim().is_empty() {
        preset.default_model.to_string()
    } else {
        profile.model.trim().to_string()
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
                "content": build_openai_content(message),
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
            "content": build_anthropic_content(message),
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
    // 服务商返回的是一坨 JSON，直接把整段甩给用户等于没说。
    // 先把里面的 message 抠出来 —— 那句话通常才是真正有用的信息。
    let detail = extract_error_message(body);
    match status {
        401 | 403 => format!("鉴权失败（{}），请检查 API Key 是否正确、是否已开通该模型。{}", status, detail),
        404 => format!("接口地址不对（404），请检查「接口地址」是否填成了正确的服务商地址。{}", detail),
        429 => format!("请求太频繁或额度不足（429）。{}", detail),
        // 5xx 是**服务商那边**的问题，不是本机也不是配置错了。
        // 说清楚这一点，用户才不会去反复改设置（实测 503 时错误原文就建议"换个服务商"）。
        500..=599 => format!(
            "服务商暂时不可用（{}），稍后重试通常就好；持续不行的话可以换一个服务商。{}",
            status, detail
        ),
        _ => format!("请求失败（{}）：{}", status, detail),
    }
}

/// 从错误响应里取出一句人能看懂的话。
///
/// 见到的形状不止一种：OpenAI 兼容是 `{"error":{"message":"..."}}`，
/// Anthropic 是 `{"error":{"type":"...","message":"..."}}`，
/// 也有直接 `{"message":"..."}` 的。取不到就退回原文（截断），**绝不返回空串** ——
/// 宁可给原始内容，也不能让用户只看到一句"请求失败"。
fn extract_error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let error = value.get("error");
        // 形状一：{"error": {"message": "..."}}（OpenAI 兼容、Anthropic 都是这个）
        if let Some(text) = error
            .and_then(|item| item.get("message"))
            .and_then(|item| item.as_str())
        {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
        // 形状二：{"error": "..."}（少数服务商直接给字符串）
        if let Some(text) = error.and_then(|item| item.as_str()) {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
        // 形状三：{"message": "..."} / {"detail": "..."}
        for key in ["message", "detail"] {
            if let Some(text) = value.get(key).and_then(|item| item.as_str()) {
                if !text.trim().is_empty() {
                    return text.trim().to_string();
                }
            }
        }
        // 连 message 都没有（有些服务商只给 code），把 code 报出来便于排查
        if let Some(code) = error
            .and_then(|item| item.get("code"))
            .and_then(|item| item.as_str())
        {
            return format!("错误代码：{}", code);
        }
    }
    body.chars().take(200).collect()
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
    // 先按协议构造请求体，再按需挂上工具声明。
    // 两种协议的工具形状不同，但"要不要带工具"对上层是同一件事。
    let mut body = match protocol {
        AiProtocol::OpenAi => build_openai_body(&request, &model),
        AiProtocol::Anthropic => build_anthropic_body(&request, &model),
    };
    if !request.tools.is_empty() {
        let declarations = match protocol {
            AiProtocol::OpenAi => openai_tools(&request.tools),
            AiProtocol::Anthropic => anthropic_tools(&request.tools),
        };
        if !declarations.is_empty() {
            body["tools"] = serde_json::json!(declarations);
        }
    }
    attach_reasoning_effort(&mut body, protocol);

    let response = match protocol {
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
    };
    let mut tool_calls = parse_tool_calls(protocol, &value);
    let mut content = content;

    // 与流式同样的兜底：模型把调用写成正文文本时，标准解析拿不到
    if tool_calls.is_empty() {
        if let Some(text) = content.clone() {
            let (inline_calls, cleaned) = extract_inline_tool_calls(&text);
            if !inline_calls.is_empty() {
                tool_calls = inline_calls;
                content = Some(cleaned);
            }
        }
    }

    // 有工具调用时 content 通常是空的 —— 那是动作意图，不是失败；
    // 两者都没有才算真的没解析出东西。
    if content.is_none() && tool_calls.is_empty() {
        return Err(format!(
            "响应里没有找到回复正文，可能模型不支持该调用方式。原始响应片段: {}",
            text.chars().take(300).collect::<String>()
        ));
    }

    Ok(AiChatReply {
        content: content.unwrap_or_default(),
        model,
        tool_calls,
    })
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
    // 工具声明与"要不要流式"是两件独立的事：流式下工具参数会分片到达，
    // 由 stream.rs 按索引拼回去，所以这里照样声明，不必为了工具放弃流式。
    if !request.tools.is_empty() {
        let declarations = match protocol {
            AiProtocol::OpenAi => openai_tools(&request.tools),
            AiProtocol::Anthropic => anthropic_tools(&request.tools),
        };
        if !declarations.is_empty() {
            body["tools"] = serde_json::json!(declarations);
        }
    }
    attach_reasoning_effort(&mut body, protocol);

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
    loop {
        // **空闲超时**，不是整段超时。
        // 整段超时是错的：正常的长回答会被从中间砍断，而"服务商不响应"却要干等满 5 分钟。
        // 真正该判断的是"多久没有新数据了" —— 长回答慢慢吐没关系，一个字节都不来就得断。
        let next = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, response.chunk()).await {
            Ok(result) => result.map_err(|error| format!("读取流式响应失败: {}", error))?,
            Err(_) => {
                return Err(format!(
                    "已经 {} 秒没有收到任何数据，连接已中断。可能是网络不稳定，或该服务商暂时没有响应。",
                    STREAM_IDLE_TIMEOUT_SECS
                ))
            }
        };
        // 流正常结束
        let Some(chunk) = next else { break };

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

    let mut tool_calls = decoder.take_tool_calls();
    // 有些模型（实测轻量档）不走标准 function calling，而是把调用当文本吐在正文里。
    // 只在标准解析一无所获时兜底 —— 否则会把正文里正常的说明文字也当成调用。
    if tool_calls.is_empty() {
        let (inline_calls, cleaned) = extract_inline_tool_calls(&full);
        if !inline_calls.is_empty() {
            tool_calls = inline_calls;
            full = cleaned;
        }
    }

    // 只有正文空**且**没有工具调用才算真的没内容：
    // 模型决定调工具时正文本来就可能为空，那不是错误。
    if full.trim().is_empty() && tool_calls.is_empty() {
        return Err("服务端没有返回任何内容，请确认所选模型支持流式输出。".to_string());
    }
    Ok(AiChatReply {
        content: full,
        model,
        tool_calls,
    })
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
                    images: Vec::new(),
                },
                AiChatMessage {
                    role: "user".to_string(),
                    content: "你好".to_string(),
                    images: Vec::new(),
                },
            ],
            model: None,
            temperature: Some(0.3),
            // 默认不带工具：工具声明由前端按模块能力决定
            tools: Vec::new(),
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
    fn images_become_parts_for_both_protocols() {
        // 带图时内容必须从字符串变成分片数组，而且两家形状不同：
        // OpenAI 用 data URI，Anthropic 用 source.base64 —— 混了就直接被服务端拒绝。
        let request = AiChatRequest {
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: "这是什么".to_string(),
                images: vec![AiImage {
                    media_type: "image/jpeg".to_string(),
                    data_base64: "AAAA".to_string(),
                }],
            }],
            model: None,
            temperature: None,
            tools: Vec::new(),
        };

        let openai = build_openai_body(&request, "m");
        let parts = openai["messages"][0]["content"].as_array().expect("应为分片数组");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/jpeg;base64,AAAA");

        let anthropic = build_anthropic_body(&request, "m");
        let parts = anthropic["messages"][0]["content"].as_array().expect("应为分片数组");
        assert_eq!(parts[1]["type"], "image");
        assert_eq!(parts[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(parts[1]["source"]["data"], "AAAA");
    }

    #[test]
    fn plain_text_messages_still_send_a_plain_string() {
        // 没图时必须保持原来的字符串形态：不改变既有请求，也少一条服务端分支
        let request = AiChatRequest {
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: "你好".to_string(),
                images: Vec::new(),
            }],
            model: None,
            temperature: None,
            tools: Vec::new(),
        };
        assert_eq!(build_openai_body(&request, "m")["messages"][0]["content"], "你好");
        assert_eq!(build_anthropic_body(&request, "m")["messages"][0]["content"], "你好");
    }

    #[test]
    fn provider_error_json_is_reduced_to_its_message() {
        // 服务商返回一坨 JSON，直接甩给用户等于没说。
        // 实测 503 就是这样：真正有用的只有 message 那一句。
        let body = r#"{"error":{"message":"Service is too busy. We advise users to temporarily switch to alternative LLM API service providers.","type":"service_unavailable_error","code":"service_unavailable_error"}}"#;
        let text = describe_http_error(503, body);
        assert!(text.contains("Service is too busy"), "应保留服务商的原文：{}", text);
        assert!(!text.contains("request_id"), "不该把整坨 JSON 带出来：{}", text);
        // 5xx 必须说清"是服务商那边的问题"，否则用户会去反复改设置
        assert!(text.contains("服务商暂时不可用"), "{}", text);
    }

    #[test]
    fn error_extraction_falls_back_gracefully() {
        // 不是 JSON：退回原文，绝不能返回空串
        assert_eq!(extract_error_message("plain gateway error"), "plain gateway error");
        // 只有 code 没有 message
        assert_eq!(
            extract_error_message(r#"{"error":{"code":"rate_limited"}}"#),
            "错误代码：rate_limited"
        );
        // 顶层 message
        assert_eq!(extract_error_message(r#"{"message":"bad request"}"#), "bad request");
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
