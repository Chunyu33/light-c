// ============================================================================
// AI 会话落盘
//
// 位置：{数据目录}/ai/sessions/{模块 id}/{YYYY-MM-DD}.jsonl
//
// 三个选择都有实际理由：
// - **按模块分目录**：切换模块时只需加载该模块的历史，这既是"模块隔离"，
//   也避免了"在旧驱动里看到垃圾清理对话"这种串台。
// - **按日期分文件**：jsonl 是追加写，一次崩溃不会毁掉整份历史；
//   清理过期会话也只需删文件，不用读改写。
// - **日期由前端传入**：本机时区的"今天"前端最清楚，后端为此引入日期库不划算。
//
// ⚠️ module_id 与 date 会被拼进文件路径，**必须先校验**：
//    否则 `..\\..\\` 这类输入就能写到数据目录之外（路径穿越）。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// 一条会话消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionMessage {
    /// 只允许 user / assistant；system 提示是每次现取的，不落盘
    pub role: String,
    pub content: String,
    /// 附件文件名（存在 attachments 目录下）。
    /// **只存文件名，不存 base64** —— 否则会话文件会被图片撑爆。
    #[serde(default)]
    pub images: Vec<String>,
    /// Unix 毫秒时间戳，便于按时间排序与展示
    pub at: i64,
    /// 思考模式下这一轮的思维链。
    ///
    /// **落盘是必须的**：服务端要求请求带 tools 时把 assistant 的 reasoning_content
    /// 原样回传（不回传 400），而重启后从磁盘恢复的历史同样要带着它发出去。
    #[serde(default)]
    pub reasoning_content: Option<String>,
    /// 这条 assistant 消息是**本地生成的**（工具查询结果），不是模型说的话。
    ///
    /// 发请求时要按用户侧内容对待 —— 一旦当成 assistant，就会变成
    /// "一条没有 reasoning_content 的 assistant"，带 tools 的请求会被服务端 400 拒掉。
    #[serde(default)]
    pub local_tool_output: bool,
    /// 产出这条回复的**档案 id**。
    ///
    /// 思维链只对产出它的那家服务商有意义：换一家（尤其严格的第三方网关）就变成未知字段，
    /// 可能被 400 拒掉。所以发请求时只回传"当前档案自己产出的"那些 ——
    /// 这个字段就是判断依据，必须落盘，否则重启后就认不出来了。
    #[serde(default)]
    pub produced_by_profile: Option<String>,
}

/// 会话根目录：{AI 数据目录}/sessions
///
/// 统一走 config 的解析逻辑，而不是自己拼一遍 ——
/// 「清空本地数据」也要按同一个路径去算大小和删除，两处必须永远指向同一个地方。
pub fn sessions_root() -> PathBuf {
    super::config::resolve_data_dir().join("sessions")
}

/// 校验模块 id：只允许小写字母、数字与连字符（内置模块 id 都是这种形状）。
/// 拒绝路径分隔符与 `..`，从源头堵住路径穿越。
fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

/// 校验日期：必须是严格的 YYYY-MM-DD。
fn is_safe_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        4 | 7 => *byte == b'-',
        _ => byte.is_ascii_digit(),
    })
}

fn session_file(module_id: &str, date: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(module_id) {
        return Err(format!("非法的模块标识: {}", module_id));
    }
    if !is_safe_date(date) {
        return Err(format!("非法的日期格式（应为 YYYY-MM-DD）: {}", date));
    }
    Ok(sessions_root().join(module_id).join(format!("{}.jsonl", date)))
}

/// 追加一条消息。目录不存在时自动创建。
pub fn append_message(module_id: &str, date: &str, message: AiSessionMessage) -> Result<(), String> {
    let path = session_file(module_id, date)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建会话目录失败 {}: {}", parent.display(), error))?;
    }

    let line = serde_json::to_string(&message).map_err(|error| format!("序列化会话消息失败: {}", error))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("打开会话文件失败 {}: {}", path.display(), error))?;
    writeln!(file, "{}", line).map_err(|error| format!("写入会话消息失败: {}", error))?;
    Ok(())
}

/// 读取某模块某天的全部消息。
/// 文件不存在返回空列表（"还没有历史"是正常状态，不是错误）；
/// 单行解析失败只跳过该行 —— 一条坏数据不该让整份历史读不出来。
pub fn load_session(module_id: &str, date: &str) -> Result<Vec<AiSessionMessage>, String> {
    let path = session_file(module_id, date)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let text = fs::read_to_string(&path)
        .map_err(|error| format!("读取会话文件失败 {}: {}", path.display(), error))?;

    let mut messages = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AiSessionMessage>(line) {
            Ok(message) => messages.push(message),
            Err(error) => log::warn!("跳过损坏的会话记录 {} 第 {} 行: {}", path.display(), index + 1, error),
        }
    }
    Ok(messages)
}

/// 删除某模块某天的会话文件（界面的「清空对话」）。
/// 文件本来就不存在时也算成功 —— 目标是"清空后是这个状态"，不是"必须删掉一个文件"。
pub fn clear_session(module_id: &str, date: &str) -> Result<(), String> {
    let path = session_file(module_id, date)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|error| format!("删除会话文件失败 {}: {}", path.display(), error))
}

/// 一次按范围读取的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionPage {
    /// **按时间正序**（旧 → 新），前端拼到消息列表顶部即可
    pub messages: Vec<AiSessionMessage>,
    /// 还有更早的没读（界面据此显示「加载更早」）
    pub has_more: bool,
}

/// 单次最多读多少条：前端传什么都夹在这个范围内，**从源头防止一次读爆**。
const MAX_RANGE_MESSAGES: usize = 200;

/// 从候选文件名里挑出要读的日期：只留合法且**不晚于** `end_date` 的，按时间倒序。
///
/// 单独抽出来是为了能单测 —— 它决定"读哪几天"，出错的后果是"历史少了"或"读到未来"。
fn candidate_dates(names: Vec<String>, end_date: &str) -> Vec<String> {
    let mut dates: Vec<String> = names
        .into_iter()
        .filter_map(|name| name.strip_suffix(".jsonl").map(str::to_string))
        // `YYYY-MM-DD` 直接按字典序比较就是时间序，不需要引入日期库
        .filter(|date| is_safe_date(date) && date.as_str() <= end_date)
        .collect();
    dates.sort_unstable();
    dates.reverse();
    dates
}

/// 从 `end_date` 往前读，攒够 `max_messages` 条就停。
///
/// 会话是**每天一个文件**，所以"加载更早"天然就是"再往前读几天"：
/// 按日期倒序逐天读，够数就返回，不做日期运算。
pub fn load_session_range(
    module_id: &str,
    end_date: &str,
    max_messages: usize,
) -> Result<AiSessionPage, String> {
    if !is_safe_segment(module_id) {
        return Err(format!("非法的模块标识: {}", module_id));
    }
    if !is_safe_date(end_date) {
        return Err(format!("非法的日期格式（应为 YYYY-MM-DD）: {}", end_date));
    }
    let limit = max_messages.clamp(1, MAX_RANGE_MESSAGES);

    let directory = sessions_root().join(module_id);
    if !directory.is_dir() {
        return Ok(AiSessionPage { messages: Vec::new(), has_more: false });
    }

    let names = fs::read_dir(&directory)
        .map_err(|error| format!("读取会话目录失败 {}: {}", directory.display(), error))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect::<Vec<String>>();
    let dates = candidate_dates(names, end_date);

    let mut collected: Vec<AiSessionMessage> = Vec::new();
    let mut consumed = 0usize;
    for date in &dates {
        // 逐天从新往旧读：新的一天拼在**前面**，读完后整体就是正序
        let mut merged = load_session(module_id, date)?;
        merged.append(&mut collected);
        collected = merged;
        consumed += 1;
        if collected.len() >= limit {
            break;
        }
    }

    // ⚠️ **按整日返回**，不在一天中间截断：
    // 「加载更早」用的是"当前最早那条所在日期的前一天"作边界 —— 如果这里切在某天中间，
    // 那半天就永远读不到了（用户看到的历史会缺一截）。
    // 只有**单日就超过两倍上限**这种极端情况才截断：宁可留个缺口，也不一次读爆。
    let mut has_more = dates.len() > consumed;
    if collected.len() > limit.saturating_mul(2) {
        collected.drain(0..collected.len() - limit);
        has_more = true;
    }

    Ok(AiSessionPage { messages: collected, has_more })
}

/// 清空某模块**所有日期**的会话（界面的「清空对话」）。
///
/// 只删当天那一个文件是不够的：历史是按天加载的，删了今天、昨天的还会被加载回来 ——
/// 用户看到的就是"清空了又冒出来"。所以清空 = 把这个模块的整个目录删掉。
pub fn clear_all_sessions(module_id: &str) -> Result<(), String> {
    if !is_safe_segment(module_id) {
        return Err(format!("非法的模块标识: {}", module_id));
    }
    let directory = sessions_root().join(module_id);
    if !directory.is_dir() {
        return Ok(());
    }
    fs::remove_dir_all(&directory)
        .map_err(|error| format!("清空会话目录失败 {}: {}", directory.display(), error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_in_module_id_and_date() {
        // 这两个是拼进路径的，必须挡住
        assert!(!is_safe_segment("../../windows"));
        assert!(!is_safe_segment("junk/clean"));
        assert!(!is_safe_segment("junk\\clean"));
        assert!(!is_safe_segment(""));
        assert!(is_safe_segment("junk-clean"));
        assert!(is_safe_segment("driver-cleanup"));
    }

    #[test]
    fn rejects_malformed_dates() {
        assert!(!is_safe_date("2026-1-1"));
        assert!(!is_safe_date("2026/10/14"));
        assert!(!is_safe_date("../2026-10"));
        assert!(is_safe_date("2026-10-14"));
    }

    #[test]
    fn session_file_is_built_under_the_module_directory() {
        let path = session_file("junk-clean", "2026-10-14").expect("合法输入应通过");
        let text = path.to_string_lossy().replace('\\', "/");
        assert!(text.ends_with("ai/sessions/junk-clean/2026-10-14.jsonl"), "实际得到 {}", text);
    }

    #[test]
    fn candidate_dates_keep_valid_past_dates_newest_first() {
        // 只读合法日期、且**不晚于** end_date；顺序必须是最新在前（加载顺序依赖它）
        let names = vec![
            "2026-10-14.jsonl".to_string(),
            "2026-10-16.jsonl".to_string(),
            "2026-10-15.jsonl".to_string(),
            "2026-10-17.jsonl".to_string(),
            "not-a-date.jsonl".to_string(),
            "2026-10-1.jsonl".to_string(),
            "README.txt".to_string(),
        ];
        let dates = candidate_dates(names, "2026-10-16");
        assert_eq!(
            dates.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["2026-10-16", "2026-10-15", "2026-10-14"]
        );
    }

    #[test]
    fn candidate_dates_are_empty_when_nothing_is_old_enough() {
        let names = vec!["2026-10-18.jsonl".to_string()];
        assert!(candidate_dates(names, "2026-10-16").is_empty());
    }
}
