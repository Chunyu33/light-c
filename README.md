# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)


c-cleanup/
├── src/                          # React前端
│   ├── api/commands.ts           # Tauri命令调用封装
│   ├── components/               # UI组件
│   │   ├── ActionButtons.tsx     # 扫描/删除按钮
│   │   ├── CategoryCard.tsx      # 分类卡片（可展开文件列表）
│   │   ├── DiskUsage.tsx         # 磁盘使用情况
│   │   ├── EmptyState.tsx        # 空状态引导
│   │   ├── ErrorAlert.tsx        # 错误提示
│   │   └── ScanSummary.tsx       # 扫描结果摘要
│   ├── hooks/useCleanup.ts       # 清理功能状态管理Hook
│   ├── types/index.ts            # TypeScript类型定义
│   ├── utils/format.ts           # 格式化工具函数
│   └── App.tsx                   # 主应用组件
├── src-tauri/src/                # Rust后端
│   ├── scanner/                  # 扫描器模块
│   │   ├── categories.rs         # 垃圾文件分类定义（10种）
│   │   ├── file_info.rs          # 文件信息结构
│   │   └── scan_engine.rs        # 扫描引擎核心逻辑
│   ├── cleaner/                  # 清理器模块
│   │   └── delete_engine.rs      # 删除引擎（含安全保护）
│   ├── commands.rs               # Tauri命令接口
│   └── lib.rs                    # 主入口
└── tailwind.config.js            # TailwindCSS配置

