<p align="center">
  <img src="src-tauri/icons/icon.svg" width="128" height="128" alt="LightC Logo">
</p>

<h1 align="center">LightC</h1>

<p align="center">
  <strong>轻量级 Windows C盘智能清理工具</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Tauri-2.x-orange?style=flat-square" alt="Tauri">
  <img src="https://img.shields.io/badge/React-19.x-61dafb?style=flat-square" alt="React">
  <img src="https://img.shields.io/badge/Rust-1.70+-dea584?style=flat-square" alt="Rust">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## ✨ 功能特性

### 🔍 一键扫描清理
- **10种垃圾分类**：Windows临时文件、系统缓存、浏览器缓存、回收站、Windows更新缓存、缩略图缓存、日志文件、内存转储、旧Windows安装、应用缓存
- **多线程并行扫描**：利用Rust的高性能并发能力，快速遍历文件系统
- **实时进度反馈**：扫描过程中实时显示当前分类和进度
- **虚拟列表优化**：大量文件列表也能流畅滚动

### � 大文件清理
- **智能扫描**：快速识别 C 盘中占用空间最大的文件
- **风险等级标识**：根据文件大小自动标记风险等级
- **一键定位**：支持打开文件所在目录或直接打开文件
- **批量选择删除**：勾选后一键清理，释放大量空间

### 💬 社交软件专清
- **多平台支持**：微信、QQ、钉钉、飞书、企业微信等主流社交软件
- **智能路径检测**：自动识别各软件的缓存目录（支持自定义安装路径）
- **分类管理**：图片视频、文件缓存、其他缓存分类展示
- **安全清理**：仅清理缓存文件，不影响聊天记录

### 🚀 系统瘦身（需管理员权限）
- **休眠文件管理**：一键关闭/开启休眠功能，释放与内存等量的空间（8-32GB）
- **系统组件清理**：调用 DISM 清理 WinSxS 组件存储中的冗余文件
- **虚拟内存优化**：检测分页文件位置，引导迁移到非系统盘
- **风险提示**：每项操作都有详细的功能说明和风险警告

### �🛡️ 安全保护
- **系统路径保护**：自动识别并跳过关键系统文件和目录
- **多层安全验证**：删除前进行路径合法性、权限、范围等多重校验
- **风险等级标识**：每个分类都有明确的风险等级提示（安全/低风险/中等/高风险）
- **操作确认**：危险操作前弹出确认对话框，防止误删

### 🎨 现代化界面
- **自定义标题栏**：无边框窗口设计，与主题色完美融合
- **深色/浅色主题**：支持跟随系统或手动切换
- **流畅动画**：所有交互都有精心设计的过渡效果
- **响应式布局**：适配不同窗口尺寸

### 🔄 自动更新
- **内置更新检查**：一键检查新版本
- **增量更新**：仅下载变更部分，节省带宽
- **签名验证**：确保更新包来源可靠

---

## 🏗️ 技术架构

```
┌──────────────────────────────────────────────────────────────────┐
│                         Frontend (React + TypeScript)             │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │     Pages        │  │  Components  │  │     Hooks        │    │
│  │  - HomePage      │  │  - TitleBar  │  │  - useCleanup    │    │
│  │  - CleanupPage   │  │  - Toast     │  │  - useToast      │    │
│  │  - BigFilesPage  │  │  - Cards     │  │                  │    │
│  │  - SocialClean   │  │  - Dialogs   │  │                  │    │
│  │  - SystemSlim    │  │  - BackBtn   │  │                  │    │
│  └──────────────────┘  └──────────────┘  └──────────────────┘    │
│                              │                                    │
│                       Tauri Commands (IPC)                        │
└──────────────────────────────┼───────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│                         Backend (Rust)                            │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │  Scanner Module  │  │  Cleaner Module  │  │ System Slimming│  │
│  │  - ScanEngine    │  │  - DeleteEngine  │  │ - Hibernation  │  │
│  │  - Categories    │  │  - SafetyCheck   │  │ - WinSxS DISM  │  │
│  │  - LargeFiles    │  │                  │  │ - PageFile     │  │
│  │  - SocialCache   │  │                  │  │ - AdminCheck   │  │
│  └──────────────────┘  └──────────────────┘  └────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                      Tauri Plugins                           │ │
│  │  - updater (自动更新)  - process (进程管理)  - opener        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📁 目录结构

```
LightC/
├── src/                              # React 前端源码
│   ├── api/
│   │   └── commands.ts               # Tauri 命令调用封装
│   ├── components/
│   │   ├── BackButton.tsx            # 返回按钮组件
│   │   ├── CategoryCard.tsx          # 垃圾分类卡片（含虚拟列表）
│   │   ├── ConfirmDialog.tsx         # 确认对话框
│   │   ├── DiskUsage.tsx             # 磁盘使用情况展示
│   │   ├── EmptyState.tsx            # 空状态引导页
│   │   ├── ErrorAlert.tsx            # 错误提示组件
│   │   ├── ScanSummary.tsx           # 扫描结果摘要
│   │   ├── SettingsModal.tsx         # 设置弹窗（通用/反馈/关于）
│   │   ├── TitleBar.tsx              # 自定义标题栏
│   │   ├── Toast.tsx                 # 轻提示通知组件
│   │   └── index.ts                  # 组件统一导出
│   ├── contexts/
│   │   ├── ThemeContext.tsx          # 主题状态管理
│   │   └── index.ts
│   ├── hooks/
│   │   └── useCleanup.ts             # 清理功能核心 Hook
│   ├── pages/
│   │   ├── HomePage.tsx              # 首页（磁盘状态 + 功能入口）
│   │   ├── CleanupPage.tsx           # 一键扫描清理页
│   │   ├── BigFilesPage.tsx          # 大文件清理页
│   │   ├── SocialCleanPage.tsx       # 社交软件专清页
│   │   ├── SystemSlimPage.tsx        # 系统瘦身页
│   │   └── index.ts                  # 页面统一导出
│   ├── types/
│   │   └── index.ts                  # TypeScript 类型定义
│   ├── utils/
│   │   └── format.ts                 # 格式化工具函数
│   ├── App.tsx                       # 主应用组件
│   ├── App.css                       # 全局样式 & CSS变量
│   └── main.tsx                      # 应用入口
│
├── src-tauri/                        # Rust 后端源码
│   ├── src/
│   │   ├── scanner/                  # 扫描器模块
│   │   │   ├── mod.rs                # 模块入口
│   │   │   ├── categories.rs         # 垃圾分类定义（10种）
│   │   │   ├── file_info.rs          # 文件/扫描结果结构体
│   │   │   └── scan_engine.rs        # 扫描引擎核心逻辑
│   │   ├── cleaner/                  # 清理器模块
│   │   │   ├── mod.rs
│   │   │   └── delete_engine.rs      # 删除引擎（含安全保护）
│   │   ├── commands.rs               # Tauri 命令接口（含系统瘦身）
│   │   └── lib.rs                    # 应用主入口
│   ├── capabilities/
│   │   └── default.json              # 权限配置
│   ├── icons/                        # 应用图标
│   ├── tauri.conf.json               # Tauri 配置
│   └── Cargo.toml                    # Rust 依赖
│
├── scripts/                          # 构建脚本
│   ├── generate-icons.js             # PNG 图标生成
│   └── generate-ico.js               # ICO 图标生成
│
├── .tauri/                           # Tauri 签名密钥（勿提交）
│   ├── update.key                    # 私钥（.gitignore）
│   └── update.key.pub                # 公钥
│
├── package.json
├── tailwind.config.js
├── vite.config.ts
└── README.md
```

---

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18.x
- **Rust** >= 1.70
- **Windows 10/11** (目标平台)

### 安装依赖

```bash
# 安装前端依赖
npm install

# Rust 依赖会在首次构建时自动安装
```

### 开发模式

```bash
npm run tauri dev
```

### 生产构建

```bash
# 设置签名环境变量（用于自动更新）
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri\update.key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-password"

# 构建
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`

---

## ⚠️ 注意事项

### 安全相关

1. **私钥保护**：`.tauri/update.key` 是更新签名私钥，**绝对不要**提交到版本控制
2. **管理员权限**：清理某些系统文件可能需要管理员权限运行
3. **谨慎删除**：高风险分类（如旧Windows安装）删除后无法恢复

### 开发相关

1. **首次编译较慢**：Rust 首次编译需要下载和编译大量依赖，请耐心等待
2. **热重载**：前端支持热重载，Rust 代码修改需要重新编译
3. **调试**：开发模式下可使用 `F12` 打开开发者工具

### 更新发布

1. 修改 `src-tauri/tauri.conf.json` 中的 `version`
2. 构建并签名
3. 上传到 GitHub Releases：
   - `LightC_x.x.x_x64-setup.nsis.zip`
   - `LightC_x.x.x_x64-setup.nsis.zip.sig`
   - `latest.json`（构建时自动生成）

---

## 📝 垃圾分类说明

| 分类 | 风险等级 | 说明 |
|------|----------|------|
| Windows临时文件 | 🟢 安全 | 系统和应用程序产生的临时文件，可安全删除 |
| 系统缓存 | 🟢 安全 | Windows 系统缓存文件 |
| 浏览器缓存 | 🟢 低风险 | 浏览器保存的网页缓存、Cookie等数据 |
| 回收站 | 🟢 低风险 | 已删除但未彻底清除的文件 |
| Windows更新缓存 | 🟡 中等 | Windows更新下载的安装包缓存 |
| 缩略图缓存 | 🟢 安全 | 文件资源管理器的缩略图缓存 |
| 日志文件 | 🟢 低风险 | 系统和应用程序的日志记录文件 |
| 内存转储 | 🟡 中等 | 系统崩溃时产生的内存转储文件 |
| 旧Windows安装 | 🔴 高风险 | Windows.old 文件夹，删除后无法回退系统 |
| 应用缓存 | 🟢 低风险 | 各类应用程序产生的缓存文件 |

---

## 🚀 系统瘦身功能说明

> ⚠️ **系统瘦身功能需要以管理员身份运行程序**

| 功能 | 预计释放空间 | 风险说明 |
|------|-------------|----------|
| **休眠文件** | 8-32GB（与内存等量） | 关闭休眠将导致快速启动功能失效，电脑无法进入休眠状态 |
| **系统组件存储** | 1-5GB | 清理 WinSxS 中的旧版本组件，清理后无法卸载已安装的更新 |
| **虚拟内存** | 取决于设置 | 仅提供迁移建议，不直接删除，需手动在系统设置中配置 |

### 使用方法

1. **右键点击** LightC 程序图标
2. 选择 **"以管理员身份运行"**
3. 进入 **系统瘦身** 页面
4. 根据需要点击各项的操作按钮

### 技术实现

- **休眠文件**：调用 `powercfg -h off/on` 命令
- **系统组件存储**：调用 `dism.exe /online /cleanup-image /startcomponentcleanup /resetbase`
- **虚拟内存**：读取注册表检测分页文件位置，打开系统属性高级设置

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

[MIT License](LICENSE)

---

## 👨‍💻 作者

**Evan Lau** - [evanspace.icu](https://evanspace.icu)

---

<p align="center">
  <sub>Light 代表轻量、轻快，寓意让您的C盘变得轻盈；C 即C盘，Windows系统的核心磁盘。</sub>
</p>

