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
pub const TOOL_READ_ITEMS: &str = "read_items";
pub const TOOL_READ_ITEM_DETAIL: &str = "read_item_detail";

/// 只读工具：它们**不改任何东西**，所以不受"必须用户明确要求才调用"的限制 ——
/// 用户问"这个分类里都有什么"时正应该调用它们。
pub fn is_read_only_tool(name: &str) -> bool {
    name == TOOL_READ_ITEMS || name == TOOL_READ_ITEM_DETAIL
}

/// 单个工具的描述与参数 schema（两种协议共用这段内容，只是外层包装不同）。
fn tool_spec(name: &str) -> Option<(&'static str, Value)> {
    match name {
        TOOL_SELECT_ITEMS => Some((
            "⚠️ 仅在用户明确要求勾选时使用（例如\"帮我勾上可安全删除的\"）。\
             用户问\"这是什么、有什么用、能不能删\"属于提问，**不要调用本工具**，先回答问题。\
             作用：把指定的项加入勾选，只改变勾选状态、不会删除任何东西；删除仍由用户在界面上确认。",
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
            "⚠️ 仅在用户明确要求删除时使用（例如\"帮我删掉回收站\"）。\
             用户问\"能不能删\"属于询问、不是指令，**不要调用本工具**，只回答并说明风险。\
             作用：申请删除指定的项；不会立即删除，界面会弹确认由用户决定。",
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
        TOOL_READ_ITEMS => Some((
            "读取模块数据的下一页明细。\
             ⚠️ 这是**只读**操作：用户问「这个分类里有什么」「具体是哪些文件」时直接调用。\
             ⚠️ 一次只返回一页：请看末尾写明的「第 N 到 M 条，共 X 条」，\
             没看到全部就不要下「全部都…」这类结论；需要更多就再调一次并加大 offset。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": {
                        "type": "string",
                        "description": "要读取的分类 id（摘要里 [id: xxx] 中的 xxx）。\
                                        模块只有一条主列表时**留空即可**。"
                    },
                    "offset": { "type": "integer", "description": "从第几条开始，默认 0" },
                    "limit": { "type": "integer", "description": "这一页读多少条，默认 30、上限 100" }
                },
                "required": []
            }),
        )),
        TOOL_READ_ITEM_DETAIL => Some((
            "读取单个条目的完整信息（完整路径、大小、时间等）。\n             ⚠️ 只读操作。item_id 必须是摘要或 read_items 结果里出现过的项。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "item_id": { "type": "string", "description": "条目 id（通常就是完整路径）" }
                },
                "required": ["item_id"]
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
    fn inline_xml_tool_call_is_recognized_and_stripped_from_text() {
        // 实测：deepseek 轻量档会把调用写成这样的文本，既不会变成 tool_calls，
        // 还会原样显示给用户。这里必须能认出来，并从正文里剔除。
        let raw = "I'll read the item list.\n<invoke name=\"read_items\">\n<parameter name=\"module\">AI 模型空间</parameter>\n</invoke>";
        let (calls, cleaned) = extract_inline_tool_calls(raw);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_items");
        // module 是模型自己起的参数名，要映射回 target_id
        assert_eq!(
            calls[0].arguments.get("target_id").and_then(|v| v.as_str()),
            Some("AI 模型空间")
        );
        // 正文里不能再留着那段 XML，否则用户会看到"模型在表演调工具"
        assert!(!cleaned.contains("<invoke"));
        assert!(cleaned.contains("I'll read the item list"));
    }

    #[test]
    fn inline_list_parameter_splits_on_commas() {
        let raw = "<invoke name=\"propose_delete\"><parameter name=\"ids\">RecycleBin, WindowsTemp</parameter></invoke>";
        let (calls, _) = extract_inline_tool_calls(raw);
        assert_eq!(calls.len(), 1);
        let ids = calls[0].arguments.get("ids").and_then(|v| v.as_array()).unwrap();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn inline_unknown_tool_is_dropped_entirely() {
        // 没声明过的工具：既不执行，也不该把这段留在正文里
        let raw = "看看这个 <invoke name=\"run_shell\"><parameter name=\"cmd\">rm -rf /</parameter></invoke>";
        let (calls, cleaned) = extract_inline_tool_calls(raw);
        assert!(calls.is_empty());
        assert!(!cleaned.contains("run_shell"));
    }

    #[test]
    fn plain_text_is_left_untouched() {
        let raw = "这是一个普通回答，里面没有任何工具调用。";
        let (calls, cleaned) = extract_inline_tool_calls(raw);
        assert!(calls.is_empty());
        assert_eq!(cleaned, raw);
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

// ---------------------------------------------------------------------------
// 文本兜底：不是所有模型都老老实实走 function calling
//
// 实测（deepseek 的轻量档）会把工具调用**当普通文本吐出来**：
//
//   I'll read the item list.
//   <invoke name="read_items">
//   <parameter name="module">AI 模型空间</parameter>
//   </invoke>
//
// 后果有三重，而且都很隐蔽：
//   1. tool_calls 是空的 → 工具不会被执行；
//   2. 这段文本会**原样显示给用户**，看起来像模型在"表演调工具"；
//   3. 模型随后还会给自己找台阶（"系统没给我查询接口"）。
//
// 所以这里做一层兜底：认出这种写法、还原成标准工具调用，并把它从正文里剔除。
// ⚠️ 只认我们声明过的工具，参数名也做有限别名映射 —— 宁可漏认，不要乱认。
// ---------------------------------------------------------------------------

/// 参数别名 → 标准参数名。模型写的是"它觉得应该叫什么"，不是我们的 schema。
fn canonical_argument(tool: &str, raw_name: &str) -> Option<&'static str> {
    let name = raw_name.trim().to_ascii_lowercase();
    match tool {
        TOOL_READ_ITEMS => {
            if matches!(name.as_str(), "target_id" | "targetid" | "id" | "module" | "category") {
                Some("target_id")
            } else if matches!(name.as_str(), "offset" | "start") {
                Some("offset")
            } else if matches!(name.as_str(), "limit" | "count" | "size") {
                Some("limit")
            } else {
                None
            }
        }
        TOOL_READ_ITEM_DETAIL => {
            if matches!(name.as_str(), "item_id" | "itemid" | "id" | "path" | "item" | "file") {
                Some("item_id")
            } else {
                None
            }
        }
        TOOL_SELECT_ITEMS | TOOL_PROPOSE_DELETE => {
            if matches!(name.as_str(), "ids" | "id" | "items" | "targets") {
                Some("ids")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 把一段 `<parameter>` 的取值整理成参数值。
/// ids 这类列表允许模型写成逗号或换行分隔的多个值。
fn argument_value(canonical: &str, raw: &str) -> Value {
    let trimmed = raw.trim();
    if canonical == "ids" {
        let ids: Vec<Value> = trimmed
            .split(['\n', ',', '，'])
            .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|item| !item.is_empty())
            .map(Value::String)
            .collect();
        return serde_json::json!(ids);
    }
    if canonical == "offset" || canonical == "limit" {
        if let Ok(number) = trimmed.parse::<i64>() {
            return serde_json::json!(number);
        }
    }
    serde_json::json!(trimmed)
}

/// 从正文里认出内联的工具调用，返回 (调用列表, 清理过的正文)。
pub fn extract_inline_tool_calls(content: &str) -> (Vec<AiToolCall>, String) {
    let mut calls: Vec<AiToolCall> = Vec::new();
    let mut remaining = String::with_capacity(content.len());
    let mut cursor = 0usize;

    while let Some(open) = content[cursor..].find("<invoke") {
        let open_at = cursor + open;
        // 开始标签的结尾
        let Some(tag_end_rel) = content[open_at..].find('>') else { break };
        let tag_end = open_at + tag_end_rel;
        let open_tag = &content[open_at..tag_end];
        let Some(name) = attribute(open_tag, "name") else {
            remaining.push_str(&content[cursor..=tag_end]);
            cursor = tag_end + 1;
            continue;
        };
        // 结束标签；找不到就当这段不是调用，原样保留
        let Some(close_rel) = content[tag_end..].find("</invoke>") else {
            cursor = tag_end + 1;
            continue;
        };
        let body_end = tag_end + close_rel;
        let body = &content[tag_end + 1..body_end];
        let block_end = body_end + "</invoke>".len();

        // 只认声明过的工具；不认识的整段丢弃（它既不该执行，也不该显示）
        if matches!(
            name.as_str(),
            TOOL_SELECT_ITEMS | TOOL_PROPOSE_DELETE | TOOL_READ_ITEMS | TOOL_READ_ITEM_DETAIL
        ) {
            let mut arguments = serde_json::Map::new();
            let mut rest = body;
            while let Some(param_open) = rest.find("<parameter") {
                let Some(param_tag_end_rel) = rest[param_open..].find('>') else { break };
                let param_tag_end = param_open + param_tag_end_rel;
                let param_tag = &rest[param_open..param_tag_end];
                let Some(param_name) = attribute(param_tag, "name") else { break };
                let Some(param_close_rel) = rest[param_tag_end..].find("</parameter>") else { break };
                let param_value = &rest[param_tag_end + 1..param_tag_end + param_close_rel];
                rest = &rest[param_tag_end + param_close_rel + "</parameter>".len()..];
                if let Some(canonical) = canonical_argument(&name, &param_name) {
                    arguments.insert(canonical.to_string(), argument_value(canonical, param_value));
                }
            }
            calls.push(AiToolCall {
                call_id: String::new(),
                name,
                arguments: Value::Object(arguments),
            });
        }

        // 正文里保留前面已确定的部分，跳过整段调用（含前面那行提示语之外的内容自己处理）
        remaining.push_str(&content[cursor..open_at]);
        cursor = block_end;
    }
    remaining.push_str(&content[cursor..]);

    // 去掉因剔除调用而留下的连续空行
    let cleaned = remaining
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (calls, cleaned.trim().to_string())
}

/// 从标签里取属性值，支持双引号与单引号。
fn attribute(tag: &str, key: &str) -> Option<String> {
    let needle = format!("{}=", key);
    let start = tag.find(&needle)? + needle.len();
    let rest = tag[start..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let inner = &rest[1..];
    let end = inner.find(quote)?;
    Some(inner[..end].trim().to_string())
}
