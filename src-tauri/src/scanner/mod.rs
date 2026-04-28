// ============================================================================
// 扫描器模块 - 负责扫描Windows系统中的垃圾文件
// ============================================================================

pub(crate) mod big_files;
mod categories;
mod context_menu;
mod file_info;
mod hotspot;
mod leftovers;
mod programdata;
mod programdata_cleaner;
mod programdata_growth;
pub(crate) mod programdata_rules;
mod programdata_snapshot;
mod registry;
mod registry_scoring;
mod scan_engine;
mod social_scanner;

pub use categories::*;
pub use context_menu::*;
pub use file_info::*;
pub use hotspot::*;
pub use leftovers::*;
pub use programdata::*;
pub use programdata_cleaner::*;
pub use programdata_growth::*;
pub use programdata_rules::*;
pub use programdata_snapshot::*;
pub use registry::*;
pub use scan_engine::*;
pub use social_scanner::*;
