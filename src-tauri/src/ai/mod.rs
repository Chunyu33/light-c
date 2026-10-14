// ============================================================================
// AI 助手 - 后端能力
//
// 设计约束（完整方案见 docs/dev/AI助手-设计方案.md）：
//
// 1. **网络请求一律在 Rust 侧发起**，API Key 永远不返回前端。
//    前端只能提交"用哪个模型、说什么话"，拿不到明文密钥 —— 这样即使界面层
//    被注入或用户打开调试面板，也拿不到 Key。
//
// 2. **服务商差异只集中在两处**：presets.rs（预设表）与 client.rs（协议适配）。
//    其余代码（配置、命令层）不必知道调用的是 DeepSeek 还是 Anthropic。
//
// 3. **横向插入**：本模块不修改任何既有模块的扫描/清理逻辑，只新增文件；
//    对外只通过 commands/ai.rs 暴露命令。
// ============================================================================

mod client;
mod config;
mod presets;
mod session;
mod stream;
mod tools;

// 对外导出：只导出命令层与前端类型真正用得到的东西。
// 注意 AiStoredConfig 含明文密钥，**只允许在 Rust 侧流转**，命令层不得把它返回给前端。
pub use client::{chat_once, chat_stream, fetch_models, AiChatReply, AiChatRequest};
pub use config::{
    cache_fetched_models, delete_profile, read_config, read_public_config, save_config, set_active_profile,
    set_data_dir, upsert_profile, AiProfile, AiPublicConfig, AiPublicProfile, AiStoredConfig,
};
pub use presets::{list_providers, AiProviderPreset};
pub use session::{append_message, clear_session, load_session, sessions_root, AiSessionMessage};
