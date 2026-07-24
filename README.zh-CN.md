# LightC

LightC 是一款 Windows 桌面工具，提供安全垃圾清理、磁盘分析和系统维护功能，使用 React、TypeScript、Rust 和 Tauri 构建。

[English](README.md)

## 主要功能

- 支持快速扫描和深度扫描的垃圾清理。
- 覆盖系统临时文件、传递优化文件、缩略图、DirectX 着色器缓存，以及指定的 Microsoft Defender 非关键文件。
- 提供大文件、磁盘健康、热点目录和磁盘增长分析。
- 提供注册表冗余、外壳/右键菜单、卸载残留、旧驱动和社交软件缓存清理工具。
- 支持 AI 模型存储分析和便携模式。
- 提供安全删除校验、详细结果、可选的重启删除和系统路径保护。

## 运行截图

<p align="center">
  <img src="public/assets/show1.png" alt="LightC 运行截图" width="900">
</p>

## 环境要求

- Windows 10 或更高版本。
- Node.js 20.19+ 和 npm。
- Rust 工具链及 Tauri 2 所需环境。

## 开发

```bash
npm install
npm run dev
npm run build
npm run tauri dev
```

## 便携模式

将 `LightC.portable.json` 放在可执行文件旁边。启用后，LightC 会把配置、本地数据和 WebView 数据保存到可执行文件旁边，而不是默认的用户目录。

## 安全说明

- LightC 不会扫描或删除 Windows Defender 根目录、隔离区、定义更新、平台数据及其他受保护的 Defender 数据。
- Defender 清理仅限可重建的 `LocalCopy` 和 `Support` 目录。
- System32 清理仅限明确支持的 DirectX 着色器缓存路径。
- 部分文件需要管理员权限或重启系统，可能会以“未立即完成”状态保留在结果中。
- 执行永久清理前请检查已选项目，并备份重要数据。

## 许可证

详见 [LICENSE](LICENSE)。
