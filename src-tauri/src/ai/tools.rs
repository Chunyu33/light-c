// ============================================================================
// AI 工具调用（function calling）
//
// 工具本身的"能力"在**模块**手里，这里只负责两件事：
//   1. 声明：把允许使用的工具按协议形状拼进请求
//   2. 解析：把模型返回的调用意图取出来，交给前端执行
//
// 设计上刻意只有**两个通用工具**，且都以"模块自己给出的 id"为参数：
//   select_items(ids)     —— P3a：改勾选态，无风险
//   propose_delete(ids)   —— P3b：申请删除，必须由用户确认后才执行
//
// 这样后端**不需要知道任何模块的细节** —— 模型要操作谁，看的是模块在摘要里给出的
// 带 id 的可操作项。新增模块只要提供 targets，工具侧一行都不用改。
// ============================================================================

use super::presets::AiProtocol;
use serde::Serialize;
use serde_json::Value;

/// 模型请求调用某个工具。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    /// 协议给的调用 id（Anthropic 回喂结果时要用；当前不回喂，先留着）
    pub call_id: String,
    pub name: String,
    /// 已解析成对象的参数；解析失败时为空对象，调用方按"没有 id"处理
    pub arguments: Value,
}

/// 允许使用的工具名。由前端按「该模块登记了哪些动作」决定传哪些。
pub const TOOL_SELECT_ITEMS: &str = "select_items";
pub const TOOL_PROPOSE_DELETE: &str = "propose_delete";

/// 单个工具的描述与参数 schema（两种协议共用这段内容，只是外层包装不同）。
fn tool_spec(name: &str) -> Option<(&'static str, Value)> {
    match name {
        TOOL_SELECT_ITEMS => Some((
            "把指定的项加入勾选。只改变勾选状态，不会删除任何东西；删除仍由用户在界面上确认。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "要勾选的项 id；必须是摘要里给出的 [id: xxx] 中的 xxx"
                    }
                },
                "required": ["ids"]
            }),
        )),
        TOOL_PROPOSE_DELETE => Some((
            "申请删除指定的项。这不会立即删除：界面会弹出确认，由用户决定是否执行。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "要删除的项 id；必须是摘要里给出的 [id: xxx] 中的 xxx"
                    }
                },
                "required": ["ids"]
            }),
        )),
        // 不认识的工具名直接忽略：前端传错不该让整个请求失败
        _ => None,
    }
}

/// OpenAI 兼容协议的工具声明。
pub fn openai_tools(names: &[String]) -> Vec<Value> {
    names
        .iter()
        .filter_map(|name| {
            tool_spec(name).map(|(description, parameters)| {
                serde_json::json!({
                    "type": "function",
                    "function": { "name": name, "description": description, "parameters": parameters }
                })
            })
        })
        .collect()
}

/// Anthropic 协议的工具声明（schema 放在 input_schema，没有 function 外层）。
pub fn anthropic_tools(names: &[String]) -> Vec<Value> {
    names
        .iter()
        .filter_map(|name| {
            tool_spec(name).map(|(description, input_schema)| {
                serde_json::json!({
                    "name": name,
                    "description": description,
                    "input_schema": input_schema
                })
            })
        })
        .collect()
}

/// 从响应里取出工具调用。
///
/// OpenAI 兼容：choices[0].message.tool_calls[] = {id, function:{name, arguments}}，
/// 其中 arguments 是**字符串形式的 JSON**，需要二次解析 —— 这一步经常被漏掉。
/// Anthropic：content[] 里 type == "tool_use" 的块，input 已经是对象。
pub fn parse_tool_calls(protocol: AiProtocol, value: &Value) -> Vec<AiToolCall> {
    match protocol {
        AiProtocol::OpenAi => parse_openai_tool_calls(value),
        AiProtocol::Anthropic => parse_anthropic_tool_calls(value),
    }
}

fn parse_arguments_string(raw: &str) -> Value {
    // 参数解析失败时给空对象：调用方会按"没有 id"处理，不会误删
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({}))
}

fn parse_openai_tool_calls(value: &Value) -> Vec<AiToolCall> {
    let Some(calls) = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(|calls| calls.as_array())
    else {
        return Vec::new();
    };

    calls
        .iter()
        .filter_map(|call| {
            let name = call.get("function")?.get("name")?.as_str()?.to_string();
            let raw = call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(|arguments| arguments.as_str())
                .unwrap_or("{}");
            Some(AiToolCall {
                call_id: call
                    .get("id")
                    .and_then(|id| id.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name,
                arguments: parse_arguments_string(raw),
            })
        })
        .collect()
}

fn parse_anthropic_tool_calls(value: &Value) -> Vec<AiToolCall> {
    let Some(blocks) = value.get("content").and_then(|content| content.as_array()) else {
        return Vec::new();
    };

    blocks
        .iter()
        .filter(|block| block.get("type").and_then(|kind| kind.as_str()) == Some("tool_use"))
        .filter_map(|block| {
            Some(AiToolCall {
                call_id: block.get("id")?.as_str()?.to_string(),
                name: block.get("name")?.as_str()?.to_string(),
                arguments: block.get("input").cloned().unwrap_or_else(|| serde_json::json!({})),
            })
        })
        .collect()
}

/// 从参数里取 ids；过滤掉空串与非字符串，保证交给模块的是干净列表。
pub fn extract_ids(arguments: &Value) -> Vec<String> {
    arguments
        .get("ids")
        .and_then(|ids| ids.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|id| id.trim())
                .filter(|id| !id.is_empty())
                .map(|id| id.to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_tool_calls_parse_arguments_from_string() {
        // arguments 是字符串形式的 JSON —— 忘了二次解析就永远拿不到 ids
        let value = serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "id": "call_1",
                        "function": { "name": "select_items", "arguments": "{\"ids\":[\"RecycleBin\"]}" }
                    }]
                }
            }]
        });
        let calls = parse_tool_calls(AiProtocol::OpenAi, &value);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "select_items");
        assert_eq!(extract_ids(&calls[0].arguments), vec!["RecycleBin".to_string()]);
    }

    #[test]
    fn anthropic_tool_use_blocks_parse_input_as_object() {
        let value = serde_json::json!({
            "content": [
                { "type": "text", "text": "我来处理" },
                { "type": "tool_use", "id": "toolu_1", "name": "propose_delete", "input": { "ids": ["WindowsTemp"] } }
            ]
        });
        let calls = parse_tool_calls(AiProtocol::Anthropic, &value);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "propose_delete");
        assert_eq!(extract_ids(&calls[0].arguments), vec!["WindowsTemp".to_string()]);
    }

    #[test]
    fn plain_text_reply_yields_no_tool_calls() {
        let value = serde_json::json!({ "choices": [{ "message": { "content": "你好" } }] });
        assert!(parse_tool_calls(AiProtocol::OpenAi, &value).is_empty());
    }

    #[test]
    fn malformed_arguments_do_not_panic_and_yield_no_ids() {
        let value = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [
                { "id": "call_1", "function": { "name": "select_items", "arguments": "not-json" } }
            ] } }]
        });
        let calls = parse_tool_calls(AiProtocol::OpenAi, &value);
        assert_eq!(calls.len(), 1);
        // 解析失败 → 空对象 → 没有 id → 调用方不会拿它去删任何东西
        assert!(extract_ids(&calls[0].arguments).is_empty());
    }

    #[test]
    fn unknown_tools_are_ignored_in_declarations() {
        let names = vec!["select_items".to_string(), "run_shell".to_string()];
        assert_eq!(openai_tools(&names).len(), 1);
        assert_eq!(anthropic_tools(&names).len(), 1);
    }

    #[test]
    fn declarations_use_each_protocol_shape() {
        let names = vec![TOOL_SELECT_ITEMS.to_string()];
        let openai = openai_tools(&names);
        assert!(openai[0].get("function").is_some(), "OpenAI 需要 function 外层");
        let anthropic = anthropic_tools(&names);
        assert!(anthropic[0].get("input_schema").is_some(), "Anthropic 用 input_schema");
        assert!(anthropic[0].get("function").is_none());
    }
}
