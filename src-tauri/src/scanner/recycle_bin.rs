// ============================================================================
// 回收站扫描器
// 只返回当前用户能够在 Windows 回收站界面看到的有效条目
// ============================================================================

use super::{CategoryScanResult, FileInfo, JunkCategory};
use log::{debug, warn};
use std::fs;
use std::path::{Path, PathBuf};

/// 扫描当前登录用户的回收站。
///
/// 回收站目录同时包含多个 SID、孤儿文件和 Shell 元数据，不能复用普通目录扫描，
/// 否则会把用户手动打开回收站时不可见的内容错误地展示出来。
pub fn scan_current_user(category: &JunkCategory, result: &mut CategoryScanResult) {
    #[cfg(windows)]
    {
        let Some(user_sid) = current_user_sid() else {
            warn!("无法获取当前用户 SID，跳过回收站扫描");
            return;
        };

        let mut entries = Vec::new();
        for drive_letter in get_drive_letters() {
            let sid_path = PathBuf::from(format!("{}:\\$Recycle.Bin\\{}", drive_letter, user_sid));
            collect_drive_entries(&sid_path, category, &mut entries);
        }

        entries.sort_by(|left, right| left.path.cmp(&right.path));
        for entry in entries {
            result.add_file(entry);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (category, result);
    }
}

#[cfg(windows)]
fn get_drive_letters() -> Vec<char> {
    // 只枚举当前存在的盘符，避免把未挂载卷传给 Shell API。
    ('A'..='Z')
        .filter(|letter| {
            let root = format!("{}:\\", letter);
            Path::new(&root).is_dir()
        })
        .collect()
}

#[cfg(windows)]
fn collect_drive_entries(sid_path: &Path, category: &JunkCategory, entries: &mut Vec<FileInfo>) {
    let directory_entries = match fs::read_dir(sid_path) {
        Ok(entries) => entries,
        Err(error) => {
            debug!("无法读取回收站目录 {:?}: {}", sid_path, error);
            return;
        }
    };

    for directory_entry in directory_entries.filter_map(Result::ok) {
        let metadata_path = directory_entry.path();
        let Some(metadata_name) = metadata_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        // Windows 回收站条目由 $I 元数据和同后缀的 $R 数据组成，其他文件不是可见条目。
        if !metadata_name.starts_with("$I") || metadata_name.len() <= 2 {
            continue;
        }

        let data_name = format!("$R{}", &metadata_name[2..]);
        let data_path = sid_path.join(data_name);
        if !data_path.exists() {
            // 缺失 $R 数据的 $I 文件是孤儿元数据，Explorer 不会将其展示为回收站条目。
            continue;
        }

        let Some((logical_size, original_path, deleted_at)) = parse_metadata(&metadata_path) else {
            continue;
        };

        let visible_name = Path::new(&original_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| original_path.clone());

        entries.push(
            FileInfo::new(
                data_path.to_string_lossy().into_owned(),
                visible_name,
                logical_size,
                deleted_at,
                data_path.is_dir(),
                category.clone(),
            )
            .with_original_path(original_path),
        );
    }
}

#[cfg(windows)]
fn parse_metadata(metadata_path: &Path) -> Option<(u64, String, i64)> {
    let bytes = fs::read(metadata_path).ok()?;
    parse_metadata_bytes(&bytes)
}

#[cfg(windows)]
fn parse_metadata_bytes(bytes: &[u8]) -> Option<(u64, String, i64)> {
    if bytes.len() < 28 {
        return None;
    }

    // Windows Vista 及以后版本的 $I 文件：版本、原始大小、删除时间、路径长度、UTF-16 路径。
    let version = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
    if version != 2 {
        return None;
    }

    let logical_size = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let filetime = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let path_length = u32::from_le_bytes(bytes[24..28].try_into().ok()?) as usize;
    let path_end = 28usize.checked_add(path_length.checked_mul(2)?)?;
    if path_length == 0 || path_end > bytes.len() {
        return None;
    }

    // 偏移 24 是路径长度字段，真正的 UTF-16 路径从偏移 28 开始，否则首字符会变成控制字符。
    let path_bytes = &bytes[28..path_end];
    let utf16_path: Vec<u16> = path_bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .take_while(|character| *character != 0)
        .collect();
    if utf16_path.is_empty() {
        return None;
    }

    let original_path = String::from_utf16_lossy(&utf16_path);
    if original_path.trim().is_empty() {
        return None;
    }

    // FILETIME 从 1601 年开始，转换为项目现有结构使用的 Unix 时间戳。
    const WINDOWS_TO_UNIX_SECONDS: u64 = 11_644_473_600;
    let deleted_at = filetime
        .checked_div(10_000_000)
        .and_then(|seconds| seconds.checked_sub(WINDOWS_TO_UNIX_SECONDS))
        .map(|seconds| seconds as i64)
        .unwrap_or(0);

    Some((logical_size, original_path, deleted_at))
}

#[cfg(all(test, windows))]
mod tests {
    use super::parse_metadata_bytes;

    #[test]
    fn parses_v2_metadata_path_without_length_prefix() {
        let original_path = r"D:\C_Map\download\Viap发布封面.png";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u64.to_le_bytes());
        bytes.extend_from_slice(&1_648_597u64.to_le_bytes());
        bytes.extend_from_slice(&132_000_000_000_000_000u64.to_le_bytes());
        bytes.extend_from_slice(&(original_path.encode_utf16().count() as u32).to_le_bytes());
        for character in original_path.encode_utf16() {
            bytes.extend_from_slice(&character.to_le_bytes());
        }

        let (_, parsed_path, _) = parse_metadata_bytes(&bytes).expect("应解析有效的 $I 元数据");
        assert_eq!(parsed_path, original_path);
    }
}

#[cfg(windows)]
fn current_user_sid() -> Option<String> {
    use std::ptr::null_mut;
    use winapi::shared::minwindef::{DWORD, HLOCAL, LPVOID};
    use winapi::shared::ntdef::HANDLE;
    use winapi::shared::sddl::ConvertSidToStringSidW;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{GetCurrentProcess, OpenProcessToken};
    use winapi::um::securitybaseapi::GetTokenInformation;
    use winapi::um::winbase::LocalFree;
    use winapi::um::winnt::{TokenUser, TOKEN_QUERY, TOKEN_USER};

    unsafe {
        let mut token_handle: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) == 0 {
            return None;
        }

        let mut required_size: DWORD = 0;
        GetTokenInformation(token_handle, TokenUser, null_mut(), 0, &mut required_size);
        if required_size == 0 {
            CloseHandle(token_handle);
            return None;
        }

        // 使用 u64 缓冲区保证 TOKEN_USER 在 Windows 目标上的对齐要求。
        let mut buffer = vec![0u64; (required_size as usize + 7) / 8];
        let success = GetTokenInformation(
            token_handle,
            TokenUser,
            buffer.as_mut_ptr() as LPVOID,
            required_size,
            &mut required_size,
        );
        if success == 0 {
            CloseHandle(token_handle);
            return None;
        }

        let token_user = buffer.as_ptr() as *const TOKEN_USER;
        let mut sid_string: *mut u16 = null_mut();
        let converted = ConvertSidToStringSidW((*token_user).User.Sid, &mut sid_string);
        CloseHandle(token_handle);
        if converted == 0 || sid_string.is_null() {
            return None;
        }

        let sid_length = (0..)
            .take_while(|offset| *sid_string.add(*offset) != 0)
            .count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, sid_length));
        LocalFree(sid_string as HLOCAL);
        Some(sid)
    }
}
