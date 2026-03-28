// ============================================================================
// 扫描器模块 - 负责扫描Windows系统中的垃圾文件
// ============================================================================

mod categories;
mod context_menu;
mod file_info;
mod hotspot;
mod leftovers;
mod registry;
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
