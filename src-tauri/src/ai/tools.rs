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
            "读取单个条目的完整信息（完整路径、大小、时间等）。\n             ⚠️ 只读操作，任何时候都可以调用。\n             item_id 用完整路径即可：可以来自摘要、read_items 的结果，**也可以是用户在自己问题里给出的那个路径**（例如行内「咨询 AI 助手」按钮带过来的路径）—— 不确定就先用 read_items 找一下。",
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

    /// 实测：deepseek-flash 会把调用写成 `<tool_call>{"name":…}</tool_call>` 的 JSON 文本。
    /// 不认的话，用户会在聊天里看到这段原文，而且那次调用根本不执行（Evan 截图反馈过）。
    #[test]
    fn json_style_tool_call_is_recognized_and_never_shown() {
        let raw = "这个驱动包可以安全清理。\n<tool_call>\n{\"name\": \"read_item_detail\", \"arguments\": {\"id\": \"oem7.inf\"}}\n</tool_call>";
        let (calls, cleaned) = extract_inline_tool_calls(raw);
        assert_eq!(calls.len(), 1, "应认出一次调用");
        assert_eq!(calls[0].name, "read_item_detail");
        assert_eq!(
            calls[0].arguments.get("item_id").and_then(|value| value.as_str()),
            Some("oem7.inf")
        );
        assert!(!cleaned.contains("tool_call"), "调用块不能留在正文里，实际: {}", cleaned);
        assert!(cleaned.contains("可以安全清理"), "正文必须保留，实际: {}", cleaned);
    }

    /// 认不出的工具名：不执行，但那段文本也必须消失 —— 用户不该看到工具语法。
    #[test]
    fn unknown_json_tool_call_is_dropped_from_text() {
        let raw = "说明。\n<tool_call>{\"name\": \"rm_rf\", \"arguments\": {}}</tool_call>";
        let (calls, cleaned) = extract_inline_tool_calls(raw);
        assert!(calls.is_empty(), "未声明的工具不能执行");
        assert_eq!(cleaned, "说明。");
    }

    /// arguments 写成 JSON 字符串（OpenAI 风格）也要能接住。
    #[test]
    fn json_style_tool_call_accepts_string_arguments() {
        let raw = "<tool_call>{\"name\": \"read_items\", \"arguments\": \"{\\\"path\\\": \\\"D:/models\\\"}\"}</tool_call>";
        let (calls, _) = extract_inline_tool_calls(raw);
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].arguments.get("target_id").and_then(|value| value.as_str()),
            Some("D:/models")
        );
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

    // ---- 手写解析器的边界：这几条都是曾经出过问题、或者一改就容易踩的地方 ----

    #[test]
    fn attributes_are_matched_on_whole_names_only() {
        // `username=` 里也含 "name=" —— 必须按属性名边界匹配，
        // 否则会把 "admin" 当成 name，真正的 name 反而取不到。
        let tag = "<invoke username=\"admin\" name=\"read_items\"";
        assert_eq!(attribute(tag, "name").as_deref(), Some("read_items"));
        assert_eq!(
            attribute("<invoke name=\"read_items\"", "name").as_deref(),
            Some("read_items")
        );
    }

    #[test]
    fn a_well_formed_inline_call_is_extracted_and_removed_from_the_body() {
        let content = "先说明一下。\n<invoke name=\"read_items\"><parameter name=\"offset\">0</parameter></invoke>\n后面还有话。";
        let (calls, cleaned) = extract_inline_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_items");
        assert_eq!(
            calls[0].arguments.get("offset").and_then(|value| value.as_i64()),
            Some(0)
        );
        assert!(cleaned.contains("先说明一下。"), "实际: {}", cleaned);
        assert!(cleaned.contains("后面还有话。"), "实际: {}", cleaned);
        assert!(!cleaned.contains("<invoke"), "调用块应被剔除，实际: {}", cleaned);
    }

    #[test]
    fn an_unclosed_invoke_tag_keeps_the_text_before_it() {
        // 模型吐了半个标签时，开标签之前的正文**不能丢** ——
        // 早先那里只推进 cursor、不把正文补回来，整段会被吞掉（而正文是要显示也要入库的）。
        let content = "这一段必须留下来。\n<invoke name=\"read_items\">";
        let (calls, cleaned) = extract_inline_tool_calls(content);
        assert!(calls.is_empty(), "残缺的调用不该被执行");
        assert!(
            cleaned.contains("这一段必须留下来。"),
            "正文被吞了，实际: {}",
            cleaned
        );
    }

    #[test]
    fn paragraph_breaks_in_the_body_are_preserved() {
        // 剔掉调用块之后只能压多余空行；正文自己的空行是 Markdown 的段落分隔，要留着。
        let content = "第一段\n\n第二段\n\n<invoke name=\"read_items\"></invoke>";
        let (calls, cleaned) = extract_inline_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert!(
            cleaned.contains("第一段\n\n第二段"),
            "段落分隔被压掉了，实际: {:?}",
            cleaned
        );
    }

    #[test]
    fn an_unclosed_invoke_tag_does_not_swallow_the_tail() {
        // 连 '>' 都没有的碎片：整段都得原样留下，不能因为"找不到开标签结尾"就丢内容
        let content = "前面的正文。\n<invoke name=\"read_items\"";
        let (calls, cleaned) = extract_inline_tool_calls(content);
        assert!(calls.is_empty());
        assert!(cleaned.contains("前面的正文。"), "实际: {}", cleaned);
        assert!(cleaned.contains("read_items"), "残片本身也该留在正文里: {}", cleaned);
    }

    #[test]
    fn dsml_markup_is_recognized_and_removed_from_the_body() {
        // 实测（deepseek-flash 思考模式 + 没声明工具时）它用自己的 DSML 标记表达工具调用。
        // 原样贴过来的形态 —— 必须能认出来，而且**不能显示给用户**。
        let content = "我来查一下。\n\
             <｜｜DSML｜｜ calls>\n\
             <｜｜DSML｜｜ invoke name=\"read_items\">\n\
             <｜｜DSML｜｜ parameter name=\"path\" string=\"true\">C:\\Users\\chunyu\\AppData\\Roaming\\devin</｜｜DSML｜｜ parameter>\n\
             </｜｜DSML｜｜ invoke>\n\
             </｜｜DSML｜｜ calls>";
        let (calls, cleaned) = extract_inline_tool_calls(content);
        assert_eq!(calls.len(), 1, "DSML 标记应当被认成一次调用，实际: {}", cleaned);
        assert_eq!(calls[0].name, "read_items");
        // `path` 是实测会被写出来的别名，不认它参数就丢了
        assert_eq!(
            calls[0].arguments.get("target_id").and_then(|value| value.as_str()),
            Some("C:\\Users\\chunyu\\AppData\\Roaming\\devin")
        );
        assert!(!cleaned.contains("DSML"), "标记不该留在正文里: {}", cleaned);
        assert!(!cleaned.contains("invoke"), "标记不该留在正文里: {}", cleaned);
        assert!(cleaned.contains("我来查一下。"), "正文要留下: {}", cleaned);
    }

    #[test]
    fn dsml_wrapper_alone_leaves_no_leftovers() {
        // 只有外层包装、没有真正的调用：不该产出调用，也不该把 `<calls>` 留在正文里
        let content = "说明文字\n<｜｜DSML｜｜ calls>\n</｜｜DSML｜｜ calls>";
        let (calls, cleaned) = extract_inline_tool_calls(content);
        assert!(calls.is_empty());
        assert!(!cleaned.contains("calls"), "包装标签不该留在正文里: {}", cleaned);
        assert!(cleaned.contains("说明文字"));
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
            // `path` / `folder` 是实测会写出来的别名：模型想"读这个文件夹里面有什么"，
            // 就会把路径写成 path（DSML 那段就是这么写的）。不认它，参数会被直接丢掉。
            if matches!(
                name.as_str(),
                "target_id" | "targetid" | "id" | "module" | "category" | "path" | "folder" | "dir"
            ) {
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

/// 把 DeepSeek 的 **DSML** 标记归一化成标准 `<invoke>` / `<parameter>` 形状。
///
/// 思考模式下**没有声明工具**时，它不会（也没有工具可）走 function calling，
/// 而是用自己的标记表达同一件事：
///
/// ```text
/// <｜｜DSML｜｜ calls>
/// <｜｜DSML｜｜ invoke name="read_items">
/// <｜｜DSML｜｜ parameter name="path" string="true">C:\…\devin</｜｜DSML｜｜ parameter>
/// </｜｜DSML｜｜ invoke>
/// </｜｜DSML｜｜ calls>
/// ```
///
/// ⚠️ 不认它有两个后果，都很糟：**工具不执行**、**这段标记原样显示给用户**。
/// 归一化之后复用同一套解析器 —— 刻意不写第二套解析器。
fn normalize_dsml(content: &str) -> String {
    if !content.contains("DSML") {
        return content.to_string();
    }
    content
        // ⚠️ 顺序很关键：DSML 前缀后面**带一个空格**（`<｜｜DSML｜｜ invoke`），
        // 所以带空格的写法必须先替换 —— 先替换不带空格的，剩下的 `< invoke` 就再也匹配不上了。
        .replace("</｜｜DSML｜｜ ", "</")
        .replace("</｜｜DSML｜｜", "</")
        .replace("<｜｜DSML｜｜ ", "<")
        .replace("<｜｜DSML｜｜", "<")
        // 外层 `<calls>` 只是包装（解析器只认 `<invoke>`），去掉免得残留在正文里
        .replace("<calls>", "")
        .replace("</calls>", "")
}

/// `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`
///
/// 第三种内联形式：Hermes 系模板和一些 OpenAI 兼容网关会把调用写成这种**JSON 文本**。
/// 实测 deepseek-flash 会这么干 —— 不认的话，用户会在聊天记录里看到一段 `<tool_call>` 原文，
/// 而且那次调用**不会被执行**（问"这个驱动是什么"，答案里带个查目录的调用，看起来像坏了）。
fn extract_json_style_tool_calls(content: &str) -> (Vec<AiToolCall>, String) {
    const OPEN: &str = "<tool_call>";
    const CLOSE: &str = "</tool_call>";

    let mut calls: Vec<AiToolCall> = Vec::new();
    let mut remaining = String::with_capacity(content.len());
    let mut cursor = 0usize;

    while let Some(open_rel) = content[cursor..].find(OPEN) {
        let open_at = cursor + open_rel;
        let Some(close_rel) = content[open_at..].find(CLOSE) else {
            // 没有结束标签 = 半截调用，正文原样保留（和 invoke 那套的处理保持一致）
            break;
        };
        let body_end = open_at + close_rel;
        let body = &content[open_at + OPEN.len()..body_end];

        // 只认声明过的工具；认不出就不执行
        let parsed = serde_json::from_str::<Value>(body.trim()).ok();
        let name = parsed
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        let declared = matches!(
            name.as_str(),
            TOOL_SELECT_ITEMS | TOOL_PROPOSE_DELETE | TOOL_READ_ITEMS | TOOL_READ_ITEM_DETAIL
        );

        if declared {
            let mut arguments = serde_json::Map::new();
            if let Some(raw) = parsed.as_ref().and_then(|value| value.get("arguments")) {
                // arguments 既可能是对象，也可能是（OpenAI 风格的）JSON 字符串
                let object = match raw {
                    Value::String(text) => serde_json::from_str::<Value>(text).ok(),
                    other => Some(other.clone()),
                };
                if let Some(Value::Object(map)) = object {
                    for (key, value) in map {
                        // 和 invoke 那套用同一份别名映射，避免两套解析器对参数名理解不一致
                        if let Some(canonical) = canonical_argument(&name, &key) {
                            arguments.insert(canonical.to_string(), value);
                        }
                    }
                }
            }
            calls.push(AiToolCall {
                call_id: String::new(),
                name,
                arguments: Value::Object(arguments),
            });
        }

        // 无论认不认得，这段 `<tool_call>` 都不能留在正文里 —— 它不是给人看的内容
        remaining.push_str(&content[cursor..open_at]);
        cursor = body_end + CLOSE.len();
    }
    remaining.push_str(&content[cursor..]);

    (calls, remaining)
}

/// 从正文里认出内联的工具调用，返回 (调用列表, 清理过的正文)。
///
/// 支持两种写法：`<invoke name="x"><parameter name="y">…</parameter></invoke>`（含 DSML 变体），
/// 以及 `<tool_call>{"name":…, "arguments":…}</tool_call>`（Hermes 系 JSON 文本）。
pub fn extract_inline_tool_calls(content: &str) -> (Vec<AiToolCall>, String) {
    // 先把 DeepSeek 的 DSML 标记归一化成标准形状，后面就只需要一套解析器
    let normalized = normalize_dsml(content);
    let content = normalized.as_str();

    let mut calls: Vec<AiToolCall> = Vec::new();
    let mut remaining = String::with_capacity(content.len());
    let mut cursor = 0usize;

    while let Some(open) = content[cursor..].find("<invoke") {
        let open_at = cursor + open;
        // 开标签连 '>' 都没有：后面不可能再出现完整调用，剩下的正文交给循环外收尾
        let Some(tag_end) = content[open_at..].find('>').map(|relative| open_at + relative) else {
            break;
        };
        let name = attribute(&content[open_at..tag_end], "name");
        // 结束标签同样必须在 —— 缺 name 或缺结束标签，都说明这段不构成调用。
        // ⚠️ 这时**必须把开标签之前的正文原样补回去**：早先这里只推进 cursor 不补正文，
        // 模型吐了半个标签的时候，它前面那整段正文会被静默丢掉（而这段是要显示、也要入库的）。
        let (Some(name), Some(close_rel)) = (name, content[tag_end..].find("</invoke>")) else {
            remaining.push_str(&content[cursor..=tag_end]);
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

    // 第二遍：`<tool_call>{json}</tool_call>` 形式（Hermes 系）。放在后面是因为
    // 它和 `<invoke>` 的块结构完全不同，各自一套扫描比混在一个循环里好读也好测。
    let (json_calls, remaining) = extract_json_style_tool_calls(&remaining);
    calls.extend(json_calls);

    // 只压掉"剔除调用块"留下的多余空行。**不能一路 filter 掉所有空行** ——
    // 那会把正文自己本来就有的空行也删掉，Markdown 的段落分隔就没了。
    (calls, collapse_blank_lines(&remaining).trim().to_string())
}

/// 把连续空行压成一个：剔除调用块之后容易留下成片空白。
fn collapse_blank_lines(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let mut consecutive_blank = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            consecutive_blank += 1;
            // 最多留一个空行，多出来的直接不要
            if consecutive_blank > 1 {
                continue;
            }
        } else {
            consecutive_blank = 0;
        }
        lines.push(line);
    }
    lines.join("\n")
}

/// 从标签里取属性值，支持双引号与单引号。
///
/// ⚠️ 必须按**属性名边界**查找：直接 `find("name=")` 会被 `username=`、`data-name=`
/// 这类属性命中，把它们的值当成 name。
fn attribute(tag: &str, key: &str) -> Option<String> {
    let needle = format!("{}=", key);
    // 从前往后逐个候选位置试，只接受"前面是空白、或者就在标签开头"的那个
    let mut search_from = 0usize;
    let start = loop {
        let found = tag[search_from..].find(&needle)? + search_from;
        let preceded_by_boundary = match tag[..found].chars().next_back() {
            None => true,
            Some(character) => character.is_whitespace(),
        };
        if preceded_by_boundary {
            break found + needle.len();
        }
        search_from = found + needle.len();
    };
    let rest = tag[start..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let inner = &rest[1..];
    let end = inner.find(quote)?;
    Some(inner[..end].trim().to_string())
}
