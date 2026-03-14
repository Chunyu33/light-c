// ============================================================================
// 扫描器模块 - 负责扫描Windows系统中的垃圾文件
// ============================================================================

mod categories;
mod file_info;
mod hotspot;
mod leftovers;
mod registry;
mod scan_engine;

pub use categories::*;
pub use file_info::*;
pub use hotspot::*;
pub use leftovers::*;
pub use registry::*;
pub use scan_engine::*;
