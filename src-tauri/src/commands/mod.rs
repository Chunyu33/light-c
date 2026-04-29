// ============================================================================
// 命令模块 - 按功能域拆分
//
// 每个子模块对应一组相关的 Tauri 命令，避免单文件过大。
// 所有命令和公共类型通过 mod.rs 统一重新导出，
// lib.rs 只需 `use commands::*` 即可注册全部命令。
// ============================================================================

mod data;
mod delete;
mod disk;
mod hotspot;
mod leftovers;
mod logger_cmd;
mod programdata;
mod registry;
mod scan;
mod social;
mod system;
mod tools;

// 公共类型（供前端和其他模块使用）
pub use data::*;
pub use delete::*;
pub use disk::*;
pub use hotspot::*;
pub use leftovers::*;
pub use logger_cmd::*;
pub use programdata::*;
pub use registry::*;
pub use scan::*;
pub use social::*;
pub use system::*;
pub use tools::*;
