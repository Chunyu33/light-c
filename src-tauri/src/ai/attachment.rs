// ============================================================================
// AI 对话里的图片附件：落盘与回读
//
// 存放位置：{AI 数据目录}/attachments/{name}.jpg
//
// **为什么不把 base64 写进会话文件**：一张压缩后的截图仍有 200~400KB，
// base64 还要再大 1/3；会话 jsonl 是逐条追加的文本，塞进去会让文件迅速膨胀，
// 而且每次读历史都要把它们全部解析出来。改成"图片存文件、记录存文件名"之后：
//   - 会话文件仍然很小、可读、可 grep；
//   - 图片能用系统看图工具直接打开（用户想留存也方便）；
//   - 界面上按需读回来显示缩略图与预览。
//
// 文件名是唯一入参，**必须校验**：它会被拼进路径，否则 `..\\` 就能写到目录外。
// 自己生成的名字天然满足 `[a-z0-9_-]`，回读时也按同一规则卡一遍。
// ============================================================================

use std::fs;
use std::path::PathBuf;

/// 单张附件的上限（压缩后通常 200~400KB，这里留足余量）。
/// 超过说明前端没压缩或数据异常，直接拒绝，避免写坏磁盘。
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

fn attachments_dir() -> PathBuf {
    super::config::resolve_data_dir().join("attachments")
}

/// 文件名只允许小写字母、数字、连字符与下划线 —— 生成时满足，回读时也要卡住。
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 96
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.')
        // 单独挡一下 `..`：点号本身允许（扩展名要用），但不能是路径片段
        && !name.contains("..")
}

fn attachment_path(name: &str) -> Result<PathBuf, String> {
    if !is_safe_name(name) {
        return Err(format!("非法的附件名: {}", name));
    }
    Ok(attachments_dir().join(name))
}

/// 保存一张附件，返回可用于回读的文件名。前端把这个名字写进会话记录。
pub fn save_attachment(data_base64: &str, media_type: &str) -> Result<String, String> {
    // 统一按 jpeg 落盘：前端压缩后就是 jpeg，这里再兜一层，避免奇怪的后缀进文件名
    let _ = media_type;
    let bytes = base64_decode(data_base64)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!("附件过大（{} 字节）", bytes.len()));
    }

    let directory = attachments_dir();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建附件目录失败 {}: {}", directory.display(), error))?;

    // 用时间戳 + 进程内计数避免重名；不引第三方 uuid，够用
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let name = format!("ai-attach-{}-{}.jpg", stamp, next_sequence());

    let path = attachment_path(&name)?;
    fs::write(&path, bytes).map_err(|error| format!("写入附件失败 {}: {}", path.display(), error))?;
    Ok(name)
}

/// 读回一张附件，返回可直接放进 `<img src>` 的 data URL。
/// 文件不存在时返回空串（历史里的图可能被清理过，界面按"没有图"处理即可）。
pub fn read_attachment(name: &str) -> Result<String, String> {
    let path = attachment_path(name)?;
    if !path.is_file() {
        return Ok(String::new());
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取附件失败 {}: {}", path.display(), error))?;
    Ok(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))
}

// --- 极小的 base64：只为附件服务，不引依赖 ---

const BASE64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in cleaned {
        let value = BASE64_TABLE
            .iter()
            .position(|c| *c == byte)
            .ok_or_else(|| "base64 内容非法".to_string())? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64_TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 进程内自增序号：同一毫秒内连存两张也不会重名。
fn next_sequence() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_in_names() {
        assert!(!is_safe_name("../../windows"));
        assert!(!is_safe_name("a/b.jpg"));
        assert!(!is_safe_name("a\\b.jpg"));
        assert!(!is_safe_name(""));
        assert!(is_safe_name("ai-attach-1760000000000-0.jpg"));
    }

    #[test]
    fn base64_round_trips() {
        // 长度 1/2/3 的边界都要对（补 = 的位置不同）
        for raw in [b"a".as_slice(), b"ab".as_slice(), b"abc".as_slice(), b"abcd".as_slice()] {
            let encoded = base64_encode(raw);
            assert_eq!(base64_decode(&encoded).unwrap(), raw, "编码 {}", encoded);
        }
    }
}
