//! AI 工具清理。
//!
//! 目录结构与 `social_scanner` 保持一致：
//! - `types`   纯数据结构（序列化给前端）
//! - `tools`   工具清单，加一个工具只改这里
//! - `core`    扫描、遍历、路径校验与删除
//! - `tests`   白名单与边界用例

mod core;
#[cfg(test)]
mod tests;
mod tools;
mod types;

pub use core::AiToolScanner;
pub use types::{AiCacheDeleteResult, AiCacheFileList, AiToolScanResult};
