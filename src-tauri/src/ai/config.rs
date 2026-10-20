// ============================================================================
// AI 配置读写（多服务商档案）
//
// 存放位置：{数据目录}/ai/ai_settings.json（跟随主数据目录，便携版也能带走）
//
// 结构：
//   { "activeProfileId": "p_xxx", "profiles": [ { ...一份完整服务商配置 } ], "dataDir": "" }
//
// 为什么是"数组 + 当前选中"而不是一份配置：
//   用户可能同时有官方 API 和第三方中转、或者不同用途用不同模型。
//   拆成档案后，"再加一个服务商"就是加一个元素，"切换"只改 activeProfileId 一个字段。
//
// 关于密钥：当前与多数桌面工具一致，以明文保存在该文件里；但**绝不回传前端** ——
//   前端只拿得到掩码（sk-****1234），界面层无法取得可用密钥。
//   后续若要做到"拷走文件也解不开"，可接 Windows DPAPI（见 docs/dev/AI服务商与密钥存储方案.md），
//   本文件对外接口不用变。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 一份服务商档案：一个密钥 + 一个地址 + 一个当前模型。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    /// 稳定 id，切换与更新都靠它
    pub id: String,
    /// 用户可改的显示名；留空时界面回落到服务商名
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    /// **上次成功拉取到的模型列表**。
    /// 必须缓存：否则界面只有一个孤零零的模型名，用户既看不到有几个可选，
    /// 也无法判断这个名字是不是还有效（历史问题：早期预设带过 default_model，
    /// 用户保存后一直显示那个名字，即使它早就不在该密钥可用的列表里）。
    #[serde(default)]
    pub models: Vec<String>,
    /// 模型列表的拉取时间（Unix 秒），0 表示从未拉过
    #[serde(default)]
    pub models_fetched_at: i64,
    /// 思考强度。**留空 = 不发送该参数** —— 不支持的模型收到它可能直接报错。
    #[serde(default)]
    pub reasoning_effort: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStoredConfig {
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    /// AI 数据目录（会话记录等）。**全局设置**，不属于某个服务商 ——
    /// 换服务商不该把聊天记录也搬走。
    #[serde(default)]
    pub data_dir: String,
}

impl AiStoredConfig {
    /// 当前生效的档案。id 找不到时回退到第一个 ——
    /// 配置还在却"用不了"是最难排查的状态，这里宁可退回一个能用的。
    pub fn active_profile(&self) -> Option<&AiProfile> {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.active_profile_id)
            .or_else(|| self.profiles.first())
    }

    pub fn active_profile_mut(&mut self) -> Option<&mut AiProfile> {
        let target = self
            .profiles
            .iter()
            .position(|profile| profile.id == self.active_profile_id)
            .or(if self.profiles.is_empty() { None } else { Some(0) })?;
        self.profiles.get_mut(target)
    }
}

/// 交给前端的档案视图：密钥只给掩码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPublicProfile {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    pub api_key_masked: String,
    pub has_api_key: bool,
    pub models: Vec<String>,
    pub models_fetched_at: i64,
    pub reasoning_effort: String,
}

/// 交给前端的整体视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPublicConfig {
    pub active_profile_id: String,
    pub profiles: Vec<AiPublicProfile>,
    pub data_dir: String,
    /// **解析后的真实目录**（配置为空时就是默认位置）。
    /// 界面要显示"到底存在哪"并支持一键打开，靠前端自己拼是拼不出来的。
    pub resolved_data_dir: String,
}

/// 解析后的 AI 数据根目录：配置为空时回落到「数据目录/ai」。
/// 会话落盘与"清空本地数据"都用它，保证两处永远指向同一个地方。
pub fn resolve_data_dir() -> PathBuf {
    let configured = read_config().data_dir;
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        crate::data_dir::get_data_dir().join("ai")
    } else {
        PathBuf::from(trimmed)
    }
}

/// 配置文件所在目录：{数据目录}/ai
fn config_dir() -> PathBuf {
    crate::data_dir::get_data_dir().join("ai")
}

/// 配置文件路径。
pub fn config_path() -> PathBuf {
    config_dir().join("ai_settings.json")
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// 把旧版单配置结构迁移成一份档案。
///
/// 旧文件长这样：`{ "providerId": "...", "baseUrl": "...", "model": "...", "apiKey": "..." }`
/// 没有 profiles 字段。**必须迁移**：否则升级后用户的密钥与模型全部"消失"。
fn migrate_legacy(value: &serde_json::Value) -> Option<AiStoredConfig> {
    let text = |key: &str| -> String {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string()
    };

    let api_key = text("apiKey");
    let provider_id = text("providerId");
    let base_url = text("baseUrl");
    let model = text("model");
    // 旧配置里连密钥都没有，就是没配过，不必造一个空档案
    if api_key.trim().is_empty() && provider_id.trim().is_empty() {
        return None;
    }

    let profile = AiProfile {
        id: "p_migrated".to_string(),
        name: String::new(),
        provider_id,
        base_url,
        model,
        models: value
            .get("models")
            .and_then(|item| item.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|item| item.to_string())
                    .collect()
            })
            .unwrap_or_default(),
        models_fetched_at: value
            .get("modelsFetchedAt")
            .and_then(|item| item.as_i64())
            .unwrap_or(0),
        api_key,
        reasoning_effort: String::new(),
    };

    Some(AiStoredConfig {
        active_profile_id: profile.id.clone(),
        profiles: vec![profile],
        data_dir: text("dataDir"),
    })
}

/// DPAPI 加密后的密钥前缀。
///
/// **没有前缀的一律当明文处理** —— 升到这个版本之前存下的老配置不需要迁移代码，
/// 读出来照样能用，下次保存时自动变成密文。
const DPAPI_PREFIX: &str = "dpapi:";

/// 二进制 → 十六进制。只是为了把密文塞进 JSON 字符串，不值得为它引 base64 依赖。
fn to_hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{:02x}", byte));
    }
    text
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(text.len() / 2);
    let chars: Vec<char> = text.chars().collect();
    for pair in chars.chunks(2) {
        let byte = u8::from_str_radix(&format!("{}{}", pair[0], pair[1]), 16).ok()?;
        bytes.push(byte);
    }
    Some(bytes)
}

/// 用当前 Windows 用户的 DPAPI 加密密钥（`CryptProtectData`）。
///
/// **只加密 api_key 这一个字段**，不动档案的其它内容：换用户 / 换机器读不回来，
/// 对密钥来说恰好是正确语义（解密失败就当没配，让用户重填，而不是把旧密文发给服务商）。
/// 加密本身失败时**退回明文**并记日志 —— 宁可降级，也不能让用户存不了密钥。
fn protect_key(plain: &str) -> String {
    if plain.trim().is_empty() || plain.starts_with(DPAPI_PREFIX) {
        return plain.to_string();
    }
    match dpapi_protect(plain.as_bytes()) {
        Some(encrypted) => format!("{}{}", DPAPI_PREFIX, to_hex(&encrypted)),
        None => {
            log::warn!("DPAPI 加密 API Key 失败，本次以明文保存");
            plain.to_string()
        }
    }
}

/// 解密（`CryptUnprotectData`）。没有前缀 = 老的明文配置，原样返回。
/// 解密失败返回空串：界面会显示"未配置"，用户重填即可 —— 绝不能把密文当密钥发出去。
fn unprotect_key(stored: &str) -> String {
    let Some(encoded) = stored.strip_prefix(DPAPI_PREFIX) else {
        return stored.to_string();
    };
    let Some(encrypted) = from_hex(encoded) else {
        log::warn!("API Key 密文格式非法，按未配置处理");
        return String::new();
    };
    match dpapi_unprotect(&encrypted) {
        Some(plain) => String::from_utf8_lossy(&plain).to_string(),
        None => {
            log::warn!("DPAPI 解密 API Key 失败（可能换了用户或机器），按未配置处理");
            String::new()
        }
    }
}

fn dpapi_protect(plain: &[u8]) -> Option<Vec<u8>> {
    use winapi::shared::minwindef::LPVOID;
    use winapi::um::dpapi::CryptProtectData;
    use winapi::um::winbase::LocalFree;
    use winapi::um::wincrypt::DATA_BLOB;

    let mut buffer = plain.to_vec();
    let mut input = DATA_BLOB {
        cbData: buffer.len() as u32,
        pbData: buffer.as_mut_ptr(),
    };
    let mut output = DATA_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return None;
    }
    let encrypted = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output.pbData as LPVOID);
    }
    Some(encrypted)
}

fn dpapi_unprotect(encrypted: &[u8]) -> Option<Vec<u8>> {
    use winapi::shared::minwindef::LPVOID;
    use winapi::um::dpapi::CryptUnprotectData;
    use winapi::um::winbase::LocalFree;
    use winapi::um::wincrypt::DATA_BLOB;

    let mut buffer = encrypted.to_vec();
    let mut input = DATA_BLOB {
        cbData: buffer.len() as u32,
        pbData: buffer.as_mut_ptr(),
    };
    let mut output = DATA_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return None;
    }
    let plain = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output.pbData as LPVOID);
    }
    Some(plain)
}

/// 落盘前把每个档案的密钥加密（已是密文的跳过，避免二次加密）。
fn encrypt_keys(config: &mut AiStoredConfig) {
    for profile in &mut config.profiles {
        profile.api_key = protect_key(&profile.api_key);
    }
}

/// 读盘后把每个档案的密钥解密（没有前缀的明文原样保留）。
fn decrypt_keys(config: &mut AiStoredConfig) {
    for profile in &mut config.profiles {
        profile.api_key = unprotect_key(&profile.api_key);
    }
}

/// 读配置。文件不存在、内容损坏都回退到默认值 —— 配置读不出来不该让界面打不开。
pub fn read_config() -> AiStoredConfig {
    let mut config = read_config_raw();
    decrypt_keys(&mut config);
    config
}

/// 真正的读取逻辑（不含加解密）。
///
/// 单独拆一层是因为 `read_config` 有好几个 return 点（默认值 / 新结构 / 旧结构迁移），
/// 解密放在外层只需要接一次 —— 以后再加分支也不会漏掉解密。
fn read_config_raw() -> AiStoredConfig {
    let path = config_path();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        // "还没配置过"是正常状态，不打日志
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AiStoredConfig::default();
        }
        Err(error) => {
            // ⚠️ 文件在、但读不出来（被占用 / 权限 / 坏盘）**不能当成"没有配置"静默过去**：
            // 用户看到的现象是"我的密钥全没了"，而查不到任何线索。
            log::warn!("读取 AI 配置失败，已回退默认值 {}: {}", path.display(), error);
            return AiStoredConfig::default();
        }
    };

    // 先当通用 JSON 读：这样才能判断是旧结构（需要迁移）还是新结构
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        log::warn!("AI 配置不是合法 JSON，已回退默认值: {}", path.display());
        return AiStoredConfig::default();
    };

    if value.get("profiles").is_some() {
        return serde_json::from_value(value).unwrap_or_else(|error| {
            log::warn!("AI 配置解析失败，已回退默认值: {} ({})", path.display(), error);
            AiStoredConfig::default()
        });
    }

    // 旧结构：迁移并**立即写回**，避免每次启动都判断一次；
    // 用户不一定会再点保存，不写回就会一直停在"看似没有配置"的状态。
    match migrate_legacy(&value) {
        Some(migrated) => {
            log::info!("检测到旧版 AI 配置，已迁移为单档案结构");
            if let Err(error) = save_config(migrated.clone()) {
                log::warn!("迁移后的配置写回失败（本次仍按迁移结果使用）: {}", error);
            }
            migrated
        }
        None => AiStoredConfig::default(),
    }
}

/// 写配置。
///
/// **必须原子写**：直接 `fs::write` 是先截断再写，中途崩溃或被结束进程就会留下半个
/// JSON —— 下次读回来解析失败 → 回退默认值 → 用户所有密钥与档案静默消失。
/// 改成"写临时文件 → rename 覆盖"：同一卷上 rename 是原子的，
/// 要么是旧的完整文件、要么是新的完整文件，没有中间态。
pub fn save_config(mut config: AiStoredConfig) -> Result<(), String> {
    // 落盘前加密密钥（只加密这一个字段）。这里改的是副本 ——
    // 调用方手里的仍是明文，返回给命令层时不必再解密。
    encrypt_keys(&mut config);
    let directory = config_dir();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建 AI 配置目录失败 {}: {}", directory.display(), error))?;

    let text = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("序列化 AI 配置失败: {}", error))?;

    let path = config_path();
    // 临时名带上进程号：避免和另一个实例/另一个正在写的临时文件撞名
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, text)
        .map_err(|error| format!("写入 AI 配置失败 {}: {}", temporary.display(), error))?;
    fs::rename(&temporary, &path).map_err(|error| {
        // 换名都失败了，临时文件没有留下的意义，顺手清掉，别在配置目录里留垃圾
        let _ = fs::remove_file(&temporary);
        format!("替换 AI 配置失败 {}: {}", path.display(), error)
    })?;
    Ok(())
}

/// 配置"读 → 改 → 写"的串行闸。
///
/// Tauri 命令是可以并发进来的，而下面每个改配置的函数都是 read_config → 改 → save_config：
/// 两个交叉执行就会丢更新（典型场景：测试连接在写模型缓存的同时，用户点了保存档案）。
/// 用 std 的 Mutex 就够 —— 这些操作只是读写一个很小的本地文件。
/// ⚠️ 不要在持闸函数内部再调另一个持闸函数：std 的 Mutex 不可重入，会死锁。
/// （`read_config` / `save_config` 自己不持闸，所以它们互相调用是安全的。）
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取配置闸。锁中毒（持锁线程 panic 过）时照常放行 —— 这道闸只防并发交叉，不保护任何不变量。
fn lock_config() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 校验并规整一份档案（新增/更新都走这里）。
///
/// 前端表单已经校验过一次，但命令层是**对外表面**（任何调用方都能传），
/// 这里再挡一道：坏档案一旦写进配置，表现出来就是"设置页看着填好了、提问却一直失败"。
fn validate_profile(mut profile: AiProfile) -> Result<AiProfile, String> {
    let preset = super::presets::list_providers()
        .into_iter()
        .find(|preset| preset.id == profile.provider_id);
    let Some(preset) = preset else {
        return Err(format!("未知的服务商: {}", profile.provider_id));
    };
    // 显示名留空时回落到服务商名：档案列表里不该出现空白项，否则用户分不清在用哪个
    if profile.name.trim().is_empty() {
        profile.name = preset.name.to_string();
    }
    // 地址留空是**合法**的（表示用预设默认地址），但填了就必须是 http(s)
    let base_url = profile.base_url.trim();
    if !base_url.is_empty() && !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(format!("接口地址必须以 http:// 或 https:// 开头: {}", base_url));
    }
    Ok(profile)
}

/// 生成新档案 id：秒级时间戳 + 重名时自增后缀。
///
/// ⚠️ 只用 `p_{秒级时间戳}` 会在"同一秒内新建两份"时撞 id ——
/// 撞了之后 upsert 会认到前一份（新填的密钥写进旧档案）、删除会把两份一起删。
fn next_profile_id(config: &AiStoredConfig) -> String {
    let base = format!("p_{}", now_seconds());
    if !config.profiles.iter().any(|profile| profile.id == base) {
        return base;
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{}_{}", base, suffix);
        if !config.profiles.iter().any(|profile| profile.id == candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

/// 新增或更新一份档案（按 id 匹配）。返回更新后的整体配置。
pub fn upsert_profile(profile: AiProfile) -> Result<AiStoredConfig, String> {
    let _guard = lock_config();
    let profile = validate_profile(profile)?;
    let mut config = read_config();
    match config.profiles.iter_mut().find(|item| item.id == profile.id) {
        Some(existing) => {
            // 密钥留空 = 不改动已保存的密钥（前端只拿得到掩码，回传不了明文）
            let previous_key = existing.api_key.clone();
            let keep_key = profile.api_key.trim().is_empty();
            *existing = profile;
            if keep_key {
                existing.api_key = previous_key;
            }
        }
        None => {
            let mut created = profile;
            if created.id.trim().is_empty() {
                created.id = next_profile_id(&config);
            }
            // ⚠️ 新建的档案**必须设为当前**。
            // 否则：界面里的表单永远编辑"当前档案"，用户新建后填的密钥会被存进旧档案，
            // 新档案永远是空的（这是实现时靠读流程发现的一个真 bug）。
            config.active_profile_id = created.id.clone();
            config.profiles.push(created);
        }
    }
    save_config(config.clone())?;
    Ok(config)
}

/// 清掉某份档案已保存的密钥（档案本身保留）。
///
/// 单独出一个入口，是因为"密钥留空 = 不改动"那条约定让用户**没法撤销**一份泄露的
/// Key（只能删掉整份档案）。撤销密钥是安全操作，必须做得到。
pub fn clear_profile_key(profile_id: &str) -> Result<AiStoredConfig, String> {
    let _guard = lock_config();
    let mut config = read_config();
    let Some(profile) = config
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    else {
        return Err(format!("要清除密钥的服务商配置不存在: {}", profile_id));
    };
    profile.api_key.clear();
    save_config(config.clone())?;
    Ok(config)
}

/// 删除一份档案。删掉的正好是当前档案时，自动切到剩下的第一份。
pub fn delete_profile(profile_id: &str) -> Result<AiStoredConfig, String> {
    let _guard = lock_config();
    let mut config = read_config();
    config.profiles.retain(|profile| profile.id != profile_id);
    if config.active_profile_id == profile_id {
        config.active_profile_id = config
            .profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_default();
    }
    save_config(config.clone())?;
    Ok(config)
}

/// 切换当前档案。
pub fn set_active_profile(profile_id: &str) -> Result<AiStoredConfig, String> {
    let _guard = lock_config();
    let mut config = read_config();
    if !config.profiles.iter().any(|profile| profile.id == profile_id) {
        return Err(format!("要切换的服务商配置不存在: {}", profile_id));
    }
    config.active_profile_id = profile_id.to_string();
    save_config(config.clone())?;
    Ok(config)
}

/// 缓存模型列表到**当前档案**：拉取成功后调用。
/// 只改这两个字段，其余配置原样保留 —— 这个函数不该有别的副作用。
pub fn cache_fetched_models(models: Vec<String>) -> Result<(), String> {
    let _guard = lock_config();
    let mut config = read_config();
    let Some(profile) = config.active_profile_mut() else {
        return Ok(());
    };
    profile.models = models;
    profile.models_fetched_at = now_seconds();
    save_config(config)
}

/// 给前端的公开视图：密钥只给掩码，另有布尔标记表示是否已配置。
pub fn read_public_config() -> AiPublicConfig {
    let stored = read_config();
    AiPublicConfig {
        active_profile_id: stored.active_profile_id.clone(),
        profiles: stored
            .profiles
            .iter()
            .map(|profile| AiPublicProfile {
                id: profile.id.clone(),
                name: profile.name.clone(),
                provider_id: profile.provider_id.clone(),
                base_url: profile.base_url.clone(),
                model: profile.model.clone(),
                api_key_masked: mask_api_key(&profile.api_key),
                has_api_key: !profile.api_key.trim().is_empty(),
                models: profile.models.clone(),
                models_fetched_at: profile.models_fetched_at,
                reasoning_effort: profile.reasoning_effort.clone(),
            })
            .collect(),
        data_dir: stored.data_dir.clone(),
        resolved_data_dir: resolve_data_dir().to_string_lossy().to_string(),
    }
}

/// 掩码规则：保留前 3 位与后 4 位，中间用固定四个星号。
/// 太短（少于 12 位）就整体打码，避免把密钥本身泄露出去。
pub fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() < 12 {
        return "****".to_string();
    }
    let prefix: String = trimmed.chars().take(3).collect();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{}****{}", prefix, suffix)
}

/// 全局数据目录设置（不属于任何档案）。
pub fn set_data_dir(data_dir: String) -> Result<AiStoredConfig, String> {
    let _guard = lock_config();
    let mut config = read_config();
    config.data_dir = data_dir;
    save_config(config.clone())?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 密钥加密：本机加密能解回原样；老配置的明文原样通过；无法解密的按"未配置"处理。
    #[test]
    fn api_key_round_trips_through_dpapi_and_legacy_plaintext_passes_through() {
        let encrypted = protect_key("sk-abcdefghijklmn");
        assert!(
            encrypted.starts_with(DPAPI_PREFIX),
            "加密后应带 dpapi: 前缀，实际 {}",
            encrypted
        );
        assert_ne!(encrypted, "sk-abcdefghijklmn", "密文不该还是明文");
        assert_eq!(unprotect_key(&encrypted), "sk-abcdefghijklmn");

        // 升版本前的明文配置：原样读出来，不需要迁移代码
        assert_eq!(unprotect_key("sk-legacy-plain-key"), "sk-legacy-plain-key");

        // 空密钥不加密：否则会存下一个"加密过的空串"，看起来像配过了
        assert_eq!(protect_key(""), "");

        // 坏密文（换机器 / 手改文件）：当未配置 —— 绝不能把密文当密钥发出去
        assert_eq!(unprotect_key("dpapi:zzzz"), "");
    }

    /// 新增档案时 id 不能撞：撞了 upsert 会认错档案、删除会删掉两份。
    #[test]
    fn new_profile_ids_do_not_collide_within_the_same_second() {
        let mut config = AiStoredConfig {
            active_profile_id: String::new(),
            profiles: Vec::new(),
            data_dir: String::new(),
        };
        let first = next_profile_id(&config);
        config.profiles.push(AiProfile {
            id: first.clone(),
            ..Default::default()
        });
        let second = next_profile_id(&config);
        assert_ne!(first, second, "同一秒内第二份档案拿到了相同 id");
        assert!(second.starts_with(&first), "冲突时应带后缀，实际 {}", second);
    }

    /// 档案校验：未知服务商与非法地址要挡住；显示名留空回落到服务商名。
    #[test]
    fn profile_validation_rejects_broken_configs_and_fills_name() {
        let unknown = validate_profile(AiProfile {
            provider_id: "not-a-provider".into(),
            ..Default::default()
        });
        assert!(unknown.is_err(), "未知服务商应被拒绝");

        let bad_url = validate_profile(AiProfile {
            provider_id: "deepseek".into(),
            base_url: "api.deepseek.com".into(),
            ..Default::default()
        });
        assert!(bad_url.is_err(), "缺协议头的地址应被拒绝");

        let ok = validate_profile(AiProfile {
            provider_id: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            ..Default::default()
        })
        .expect("合法档案应通过");
        assert!(!ok.name.trim().is_empty(), "显示名留空时应回落到服务商名");

        // 地址留空 = 用预设默认地址，必须放行
        assert!(validate_profile(AiProfile {
            provider_id: "deepseek".into(),
            ..Default::default()
        })
        .is_ok());
    }

    #[test]
    fn legacy_single_config_migrates_into_one_profile() {
        // 旧文件没有 profiles 字段；不迁移就等于用户配置全丢
        let legacy = serde_json::json!({
            "providerId": "deepseek",
            "baseUrl": "https://api.deepseek.com",
            "model": "deepseek-chat",
            "apiKey": "sk-abcdefghijklmn",
            "models": ["deepseek-chat", "deepseek-reasoner"]
        });
        let migrated = migrate_legacy(&legacy).expect("有密钥就该迁移");
        assert_eq!(migrated.profiles.len(), 1);
        assert_eq!(migrated.profiles[0].model, "deepseek-chat");
        assert_eq!(migrated.profiles[0].models.len(), 2);
        // 迁移出来的档案必须是当前档案，否则用户保存了却不生效
        assert_eq!(migrated.active_profile_id, migrated.profiles[0].id);
    }

    #[test]
    fn empty_legacy_config_is_not_migrated_into_a_ghost_profile() {
        let legacy = serde_json::json!({});
        assert!(migrate_legacy(&legacy).is_none());
    }

    #[test]
    fn active_profile_falls_back_to_first_when_id_is_stale() {
        let config = AiStoredConfig {
            active_profile_id: "p_missing".to_string(),
            profiles: vec![AiProfile {
                id: "p_1".to_string(),
                provider_id: "deepseek".to_string(),
                ..Default::default()
            }],
            data_dir: String::new(),
        };
        assert_eq!(config.active_profile().map(|p| p.id.as_str()), Some("p_1"));
    }

    #[test]
    fn masking_keeps_edges_but_hides_the_middle() {
        assert_eq!(mask_api_key("sk-abcdefghijklmn"), "sk-****klmn");
        assert_eq!(mask_api_key("short"), "****");
        assert_eq!(mask_api_key(""), "");
    }
}
