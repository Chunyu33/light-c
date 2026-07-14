// ============================================================================
// 扫描器模块 - 负责扫描Windows系统中的垃圾文件
// ============================================================================

pub(crate) mod big_files;
pub(crate) mod big_files_engine;
mod categories;
mod context_menu;
mod file_info;
mod hotspot;
pub(crate) mod hotspot_engine;
mod leftovers;
mod recycle_bin;
mod registry;
mod registry_scoring;
mod scan_engine;
mod social_scanner;

pub use categories::*;
pub use context_menu::*;
pub use file_info::*;
pub use hotspot::*;
pub use leftovers::*;
pub use registry::*;
pub use scan_engine::*;
pub use social_scanner::*;
