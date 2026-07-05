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
  <img src="https://img.shields.io/badge/license-Source%20Available-green?style=flat-square" alt="License">
</p>


## 📸 运行截图

<p align="center">
  <img src="public/assets/show1.png" alt="LightC Screenshot" width="900">
  <img src="public/assets/show2.png" alt="LightC Screenshot" width="900">
  <img src="public/assets/show3.png" alt="LightC Screenshot" width="900">
  <img src="public/assets/show4.png" alt="LightC Screenshot" width="900">
  <img src="public/assets/show5.png" alt="LightC Screenshot" width="900">
  <img src="public/assets/show6.png" alt="LightC Screenshot" width="900">
  <img src="public/assets/show7.png" alt="LightC Screenshot" width="900">
</p>

## ✨ 功能特性

### 🔍 一键扫描清理
- **10种垃圾分类**：Windows临时文件、系统缓存、浏览器缓存、回收站、Windows更新缓存、缩略图缓存、日志文件、内存转储、旧Windows安装、应用缓存
- **多线程并行扫描**：利用Rust的高性能并发能力，快速遍历文件系统
- **实时进度反馈**：扫描过程中实时显示当前分类和进度
- **扫描停止控制**：扫描过程中可随时点击停止按钮终止所有扫描任务
- **回收站安全清空**：通过 Windows Shell API 清空回收站，支持所有驱动器的回收站文件一键清理
- **虚拟列表优化**：大量文件列表也能流畅滚动

### 🔍 大文件清理
- **MFT 全量扫描引擎**：管理员运行时自动启用 NTFS USN Journal 枚举 + 顺序解析 `$MFT` 文件大小，先维护大文件候选池再懒重建候选路径，避免逐文件 metadata IO；非管理员或 MFT 失败时自动降级为原有遍历方案
- **系统目录保护**：MFT 模式覆盖全盘普通文件 TopN，同时跳过关键系统目录，降低误删核心系统文件的风险
- **智能扫描**：自动检测系统盘，MFT 优先、WalkDir 降级，并用最小堆维护 Top N 最大文件
- **可调扫描量**：支持自定义返回数量 (10-200，默认 50， 未接入前端)
- **后端风险计算**：Rust 端基于路径规则计算风险等级 (1-5)，高风险文件前端锁定不可选
- **来源标签**：自动识别文件来源（微信文件、Steam 游戏、虚拟机磁盘、系统临时文件等 20+ 标签）
- **实时进度**：扫描时显示当前路径和已扫描文件数，支持中途取消
- **阶段耗时诊断**：MFT 模式下展示枚举、大小解析、候选路径等阶段信息，方便定位扫描瓶颈
- **一键定位**：支持打开文件所在目录、直接打开文件，或按设置中的搜索引擎搜索完整路径辅助判断是否可删
- **批量选择删除**：勾选后一键清理，释放大量空间

### 💬 社交软件专清
- **多平台支持**：微信、QQ、钉钉、飞书、企业微信等主流社交软件
- **智能路径检测**：自动识别各软件的缓存目录（支持自定义安装路径）
- **分类管理**：图片视频、文件缓存、动态缓存、临时缓存分类展示，微信 `Sns`、`WebView`、小程序等常见缓存目录会独立归类
- **安全清理**：仅清理缓存文件，不影响聊天记录

### 🚀 系统瘦身（需管理员权限）
- **休眠文件管理**：一键关闭/开启休眠功能，释放与内存等量的空间（8-32GB）
- **系统组件清理**：检查页对 DISM 组件存储分析使用短超时和 10 分钟缓存，避免每次打开都长时间等待；实际清理仍调用 DISM 清理 WinSxS 冗余文件
- **虚拟内存优化**：检测分页文件位置，引导迁移到非系统盘
- **风险提示**：每项操作都有详细的功能说明和风险警告

### 🔬 大目录分析
- **双模式扫描**：默认 AppData 智能分析（快速定位用户数据热点），深度扫描模式覆盖全盘一级目录
- **MFT 直读引擎**：管理员运行时深度扫描自动启用 NTFS USN 枚举 + `$MFT` 顺序大小解析，秒级完成全盘扫描（类似 WizTree）；非管理员或 MFT 失败时保留 jwalk 降级遍历
- **树形层级展示**：基于 MFT/遍历聚合缓存构建内存父子索引，结果页按设置深度展示目录树，避免结果生成阶段反复读取磁盘目录
- **可调展示深度**：设置中调节展示层数（2-4 层），实际扫描深度固定 6 层确保覆盖率
- **大小阈值过滤**：可配置最低展示大小（10-500MB），自动过滤噪音目录
- **系统目录过滤开关**：深度扫描时可选择是否扫描系统保护目录（Windows、Program Files 等），关闭后系统目录会参与 TopN 排名，便于直接看到 `C:\Windows`、`WinSxS`、`System32` 这类占用大户
- **热点展开机制**：容器级大目录（>20GB/系统保护目录）自动展开为子目录参与 TopN 竞争
- **无限下钻弹窗**：点击目录右侧 ▶ 按钮进入沉浸式模态框，支持无限层级探索 + 面包屑导航
- **智能标记**：自动识别缓存目录、系统保护目录、程序目录，辅助安全决策
- **一键清理**：支持清空缓存目录内容（保留根目录），跳过占用文件
- **实时进度**：深度扫描模式下结构化展示 MFT 枚举、索引建立、大小读取、目录聚合、结果生成等阶段耗时，支持中途取消并辅助定位性能瓶颈
- **文件夹徽标列表**：结果列表使用黄色文件夹徽标承载目录语义，序号作为角标展示，树形层级更容易扫读

### 🎯 深度卸载残留清理（置信度评分引擎）
- **置信度评分模型**：基线 0.0，综合卸载程序残留、历史安装路径、可执行文件、长时间未修改等正向信号，并用当前已安装应用映射、DisplayName 命中、通用目录、ProgramData、共享厂商目录等保护信号降权；score ≥ 0.75 为高置信度残留，0.40~0.75 为可疑项
- **结构化应用映射**：从注册表 Uninstall 键提取 InstallLocation 末级/倒数第二级目录名构建精确映射，不再拆分 DisplayName token，杜绝短词碰撞误判
- **保守默认选择**：卸载后残留无法做到 100% 权威判断，所有结果默认不勾选；高置信度只作为优先提示，用户需要结合路径和软件使用情况手动确认
- **预过滤降噪**：包名格式目录（`com.xxx.yyy`）和纯版本号目录（`1.2.3.4`、`v2.0`）在评分前直接跳过
- **结构化白名单**：`Exact` / `Prefix` / `Pattern` 三种规则，禁止全局 `contains` 匹配
- **虚拟磁盘识别**：可识别常见虚拟磁盘文件，同时自动排除 WSL2、Docker 等已知应用环境，避免误删系统或开发数据
- **智能白名单保护**：覆盖 100+ 常见应用（微信、QQ、Steam、VS Code、Docker、剪映/CapCut、WSL2 等），并尽量降低正在使用的应用数据被误判为残留的概率
- **注册表深度扫描**：扫描 HKCU/HKLM Software 下的孤立注册表项和孤立驱动服务项
- **大文件高亮**：模拟器残留和大型文件以红色高亮显示，方便快速识别

### 📝 注册表残留清理
- **单一目标扫描**：只扫描 `HKCR\Applications` 下的文件关联残留，不碰系统关键区域
- **铁证条件过滤**：关联 exe 不存在 + 非系统路径 (Windows/System32/SysWOW64) + 非系统进程 (svchost/rundll32)
- **真实备份恢复**：删除前使用 `reg.exe export` 生成完整 .reg 备份文件，支持双击恢复
- **一键安全清理**：所有输出均已通过安全验证，默认全选，一键删除

### ️️ 右键菜单清理
- **深度扫描注册表**：基于 Rust 高性能 winreg 扫描器，覆盖任意文件、文件夹、桌面背景、磁盘驱动器等所有场景
- **MUIVerb 间接字符串解析**：通过 `SHLoadIndirectString` FFI 调用 Windows API 解析 `@%SystemRoot%\System32\xxx.dll,-1234` 等原始字符串为人类可读的菜单名称
- **系统级菜单项自动保护**：`shellex\ContextMenuHandlers` 下的系统级右键菜单条目自动禁止选中和删除，防止破坏系统右键功能
- **风险三级徽标**：每个条目标注风险等级（安全/谨慎/危险），一目了然
- **智能识别失效项**：自动检查菜单命令中引用的 exe 文件是否存在，默认勾选失效条目
- **删除前自动备份**：清理前自动导出 .reg 备份文件，出问题可双击还原
- **分权限操作**：用户级（HKCU）不需管理员即可删除；系统级（HKLM）标识需要管理员权限

### 📂 C 盘全盘分析
- **MFT 快速扫描**：原 ProgramData 分析入口升级为 C 盘全盘分析，管理员运行时通过 NTFS MFT 枚举重建目录树，并顺序扫描 `$MFT` 建立文件大小表，避免传统全盘递归扫描和大量逐文件 metadata IO
- **可取消扫描**：模块内停止按钮与顶部全局“停止扫描”都会通知后端中断 MFT 扫描，取消后不会展示半截结果
- **快照对比**：每次扫描都会保存全盘目录聚合快照，并与上一次快照对比，计算 C 盘净新增/净减少空间；文件级明细采用同名分片目录存储，避免多 TB 磁盘下生成或读取超大主 JSON；快照最多保留 3 组，超过后自动清理旧主快照和同名分片目录
- **变化目录定位**：结果列表优先展示本次与上次之间发生变化的目录、当前大小、变化量、变化级别和原因提示，支持一键打开目录或按设置中的搜索引擎搜索路径用途继续排查；变化项按变化量排序，并自动折叠变化量完全一致的冗余父级目录，默认最多展示 300 个目录，可在设置中调整为 50-1000
- **变化明细弹窗**：点击变化量默认双栏展示子目录与文件级变化，目录和文件均通过 Rust API 按需分页加载，每次最多 200 条，并使用虚拟滚动保持大结果集流畅；子目录支持面包屑式下钻并保留一键打开目录
- **深层变化兜底**：当快照深度边界目录的变化来自更深层文件、直属文件没有可解释变化时，后端会按分片流式对比并只保留当前分页需要的 Top 明细，避免出现“有变化量但无明细”的空弹窗，同时控制超大磁盘下的内存占用
- **颜色指标说明**：蓝色表示新增文件/目录，红色表示 1GB 及以上显著增长，橙色表示 300MB 及以上快速增长，黄色表示轻微增长，绿色表示相比上次快照减少，灰色表示基本稳定
- **稳定布局**：主窗口初始宽度与最小宽度保持一致，全盘分析概览指标固定四列展示，避免关键指标在窄窗口下换行
- **上次扫描时间**：结果区展示上一份快照时间，并明确当前列表是“变化目录”还是首次/无变化时的“占用基线”列表
- **阶段耗时诊断**：扫描中展示 MFT 枚举、路径重建、文件大小读取、目录聚合等阶段进度，扫描完成后展示各阶段耗时，便于定位性能瓶颈
- **首次扫描行为**：首次扫描只建立基准快照；从第二次扫描开始展示新增、减少和显著增长目录
- **超大磁盘适配**：文件级明细按分片懒加载，几个 TB 的 C 盘也不会因为打开明细而一次性读取超大快照；实际扫描耗时主要取决于文件数量、`$MFT` 体积、硬盘类型和安全软件实时扫描，应用启动后的首次 MFT 扫描可能因系统缓存预热而更慢
- **模块化实现**：全盘扫描、快照和增长分析代码已迁移到 `src-tauri/src/disk_growth/`，命令入口统一为 `scan_disk_growth`

### 🤖 AI 模型空间
- **功能说明**：快速分析本机 AI 模型、LoRA、Embedding 和模型缓存占用，首页优先展示 AI 资产总占用与最大模型，帮助用户 3 秒内定位空间大户
- **平台识别优先**：首版支持 Ollama、LM Studio、ComfyUI、HuggingFace Cache；Ollama 会读取 `OLLAMA_MODELS` 并解析 manifest 映射共享 blob，展示真实模型名而不是 `sha256-*` 文件名
- **配置与结构优先**：HuggingFace 会优先读取 `HF_HOME`；ComfyUI 会识别 Python 版 `extra_model_paths.yaml`、桌面版 `%APPDATA%\ComfyUI\config.json` 的 `basePath`、`extra_models_config.yaml`、默认 `models` 目录和 `diffusion_models`、`text_encoders`、`controlnet` 等现代模型目录；LM Studio 仅识别明确的 `.lmstudio` 路径，避免把普通 `models` 目录误判为 LM Studio
- **深度发现开关**：默认快速扫描只读取配置和平台目录；开启“深度发现”后才会追加 MFT 兜底扫描本地 NTFS 盘，按 `.safetensors`、`.gguf`、`.ggml`、`.ckpt`、`.onnx`、`.ort`、`.tflite`、`.pb`、`.h5`、`.hdf5`、`.keras`、`.mlmodel`、`.mlpackage`、`.engine`、`.plan`、`.trt`、`.mnn`、`.rknn`、`.mindir`、`.om`、`.pdmodel`、`.pdiparams`、`.caffemodel`、`.dlc`、`.hef`、`.xmodel`、`.bmodel`、`.pte`、`.task`、`.nemo`、`.bin`、`.pt`、`.pth` 等格式分层过滤大模型候选；`.bin/.pt/.pth` 等高误判扩展名必须达到更高体积阈值，并跳过已由配置层覆盖的路径；其中 `.bin/.dlc` 在 MFT 兜底中还会结合 AI/模型目录或强模型文件名特征确认，并排除 Steam、3DMark 等游戏/跑分资源目录，避免把大型资源包误报为模型
- **使用方式**：点击“AI 模型空间”模块中的“开始分析”手动触发扫描；如果模型由绿色版 llama.cpp、Pinokio、AI Toolkit 或自建目录管理，不确定模型放在哪个盘时再开启“深度发现”
- **结果展示**：提供总占用、最大模型、超过 20GB 的模型数量、概览图表、模型列表筛选、关键词搜索、一键清空搜索、打开目录和一键搜索模型能力；平台标签使用主色实心样式，类型标签统一展示文件扩展名，“未归类”用暖色提醒，长路径采用中间省略以尽量保留模型文件名；同一路径命中多个来源时按平台优先级去重，避免重复计数
- **视图收敛**：概览视图用平台占用饼图、模型类型柱状图和未归类提示展示空间结构，类型柱状图保留平台模型类别并用扩展名兜底，长尾类型会汇总为“其他类型”避免截断总量；模型列表视图承载完整结果，并使用统一主题下拉框支持按平台和类型筛选，表头支持按名称/大小升降序排序，避免多个视图重复堆列表
- **阶段反馈**：深度发现期间通过 `ai-models:progress` 事件展示 MFT 枚举、候选筛选、大小读取、路径重建和结果汇总等阶段；扫描完成后在总览卡片的耗时入口 hover 展示各阶段耗时与总耗时，便于判断瓶颈且不干扰模型结果主信息
- **变更点**：Rust `ai_models` 扫描模块新增配置优先 + MFT 兜底分层，`scan_ai_model_assets` Tauri 命令支持深度发现参数和阶段进度事件，MVP 仅做可视化分析与定位，不提供删除或自动清理

### ⚙️ 设置与本地数据
- **使用说明收敛**：设置页使用说明补充“AI 模型空间”，并压缩大目录分析、C 盘全盘分析说明，保留核心使用边界
- **配置与数据分离**：应用配置固定保存在 `%LOCALAPPDATA%/LightC/config/config.json`，默认运行数据保存在 `%LOCALAPPDATA%/LightC/data/`；更改数据目录只迁移日志、备份、快照和安装历史缓存，不把配置文件混入用户选择的数据目录
- **数据目录迁移保护**：更改数据目录时必须选择独立空文件夹，禁止选择当前数据目录、父目录或子目录；迁移只复制 LightC 明确拥有的日志、备份、快照和安装历史缓存，避免误选磁盘根目录后把无关文件继续迁移
- **可选本地数据清理**：清空本地数据前会列出安装历史缓存、清理日志、注册表备份、全盘分析快照等白名单项，显示路径、文件数、大小和影响说明；用户可按项勾选清理，应用配置不会被删除

### �🛡️ 安全保护
- **系统路径保护**：自动识别并跳过关键系统文件和目录
- **多层安全验证**：删除前进行路径合法性、权限、范围等多重校验
- **风险等级标识**：每个分类都有明确的风险等级提示（安全/低风险/中等/高风险）
- **操作确认**：危险操作前弹出确认对话框，防止误删

### 🎨 现代化界面
- **自定义标题栏**：无边框窗口设计，与主题色完美融合
- **深色/浅色主题**：支持跟随系统或手动切换
- **字体大小调节**：支持标准/适中/较大三档字号，满足不同视力需求
- **双布局模式**：支持默认卡片总览模式和传统 PC 软件式页面模式，左侧模块导航会自动在锚点滚动与页面切换之间切换；页面模式保留模块状态，非当前页模块会跳过大列表/图表 DOM 渲染，并按模块独立订阅扫描状态与当前页轻量入场动画，降低多模块有结果后的菜单切换卡顿
- **搜索引擎设置**：通用设置中可选择 Bing、Google 或百度，所有结果列表的搜索按钮会统一使用该偏好
- **模块操作按钮**：各功能模块的开始/重新扫描按钮保持清晰按钮边界，垃圾分类展开支持手风琴过渡
- **扫描状态占位**：卸载残留、注册表冗余等模块在扫描期间展示关键步骤与进度骨架，页面模式下不再出现大面积空白
- **回到顶部**：长列表滚动到一定距离后显示悬浮回顶按钮，点击后平滑返回顶部
- **流畅动画**：所有交互都有精心设计的过渡效果
- **响应式布局**：适配不同窗口尺寸
- **更多工具入口**：关于页新增 Viap、BinlockX 推荐卡片，可直接跳转夸克网盘下载同作者工具

### ⚡ 系统快捷工具
- **开机启动管理**：一键打开任务管理器启动项页面，禁用不必要的自启动软件
- **存储感知**：快速调用 Windows 原生的磁盘清理与空间管理功能

### 🎬 启动动画
- **官方正版验证视觉**：启动时展示像素风 Logo + 新海诚风格扫描光束动画
- **SHA-256 校验提示**：动画过程中显示"Checking File Integrity..."文字，强化正版意识
- **品牌背书**：底部常驻"Evan的像素空间 · 官方正版"标识及防篡改警示
- **双窗口架构**：Tauri 2.0 splashscreen + main 窗口分离，启动体验更流畅

### 🔐 安全与校验
- **官方版本安全声明**：设置中独立选项卡，警示第三方打包风险（捆绑插件、主页劫持、后门程序）
- **一键完整性校验**：设置 → 安全与校验 可直接验证当前 LightC.exe 是否通过官方 ed25519 签名；安装版和便携版分别读取 Release 中的 `LightC_installer_exe.sig` / `LightC_portable_exe.sig`
- **签名格式兼容**：校验逻辑会兼容历史 Release 中被双重 base64 包装的签名资产，并把签名资产异常与文件内容不一致分开提示，降低官方包误报风险
- **版权与渠道声明**：首页底部及设置中明确标注官方发布渠道（GitHub Releases、当前 Release 的 `download.json` 网盘链接、B站/抖音 @Evan的像素空间），并提示第三方转载、网盘引流和二次打包风险

---

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Frontend (React 19 + TypeScript + TailwindCSS 4)        │
│  ┌────────────────────┐  ┌─────────────────────┐  ┌───────────────────┐     │
│  │       Pages        │  │     Components      │  │      Hooks        │     │
│  │  - HomePage        │  │  - TitleBar         │  │  - useCleanup     │     │
│  │  - CleanupPage     │  │  - Toast            │  │                   │     │
│  │  - BigFilesPage    │  │  - CategoryCard     │  │                   │     │
│  │  - SocialCleanPage │  │  - ConfirmDialog    │  │                   │     │
│  │  - SystemSlimPage  │  │  - SettingsModal    │  │                   │     │
│  └────────────────────┘  │  - WelcomeModal     │  └───────────────────┘     │
│                          │  - ScanProgress     │                            │
│  ┌────────────────────┐  │  - ScanSummary      │  ┌───────────────────┐     │
│  │  - Hotspot         │                                                     │
│  │  - Leftovers       │                                                     │
│  │  - Registry        │                                                     │
│  │  - ContextMenu     │                                                     │
│  │  - DiskGrowth      │                                                     │
│  │  - SystemSlim      │                                                     │
│  └────────────────────┘                                                     │
│                                    │                                        │
│                             Tauri Commands (IPC)                            │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │
┌────────────────────────────────────┼────────────────────────────────────────┐
│                              Backend (Rust)                                  │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │   Scanner Module    │  │   Cleaner Module    │  │   System Slimming   │  │
│  │  - scan_engine      │  │  - delete_engine    │  │  - Hibernation      │  │
│  │  - categories       │  │  - enhanced_delete  │  │  - WinSxS DISM      │  │
│  │  - file_info        │  │  - permanent_delete │  │  - PageFile         │  │
│  │  - social_scanner   │  └─────────────────────┘  │  - AdminCheck       │  │
│  │  - hotspot          │                           └─────────────────────┘  │
│  │  - leftovers        │  ┌─────────────────────┐                           │
│  │  - registry         │  │   Logger Module     │                           │
│  │  - context_menu     │  └─────────────────────┘                           │
│  │  - disk_growth/*    │  ┌─────────────────────┐                           │
│  │  (MFT/snapshot/     │  │   Data Dir Module   │                           │
│  │   growth)           │  └─────────────────────┘                           │
│  └─────────────────────┘                                                   │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                          Commands Layer (IPC)                            │ │
│  │   commands/disk.rs   commands/scan.rs   commands/social.rs              │ │
│  │   commands/delete.rs   commands/system.rs   commands/leftovers.rs       │ │
│  │   commands/registry.rs   commands/hotspot.rs   commands/disk_growth.rs  │ │
│  │   commands/tools.rs   commands/logger_cmd.rs   commands/data.rs         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                           Tauri Plugins                                 │ │
│  │   - process (进程管理)   - opener (文件打开)   - dialog (原生对话框)    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Core Dependencies                               │ │
│  │   - rayon (并行计算)   - walkdir (目录遍历)   - winreg (注册表操作)     │ │
│  │   - tokio (异步运行时)   - chrono (时间处理)   - winapi (系统API)       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 目录结构

```
LightC/
├── src/                              # React 前端源码
│   ├── api/
│   │   └── commands.ts               # Tauri 命令调用封装
│   ├── assets/                       # 静态资源（二维码等）
│   ├── components/
│   │   ├── modules/                  # 功能模块卡片组件
│   │   │   ├── BigFilesModule.tsx    # 大文件清理模块
│   │   │   ├── HotspotModule.tsx     # 大目录分析模块
│   │   │   ├── DrillDownModal.tsx    # 大目录下钻模态框
│   │   │   ├── JunkCleanModule.tsx   # 垃圾清理模块
│   │   │   ├── LeftoversModule.tsx   # 卸载残留模块
│   │   │   ├── RegistryModule.tsx    # 注册表清理模块
│   │   │   ├── ContextMenuModule.tsx # 右键菜单清理模块
│   │   │   ├── DiskGrowthModule.tsx # C 盘全盘分析模块
│   │   │   ├── SocialCleanModule.tsx # 社交软件专清模块
│   │   │   ├── SystemSlimModule.tsx  # 系统瘦身模块
│   │   │   └── index.ts
│   │   ├── ActionButtons.tsx         # 操作按钮组
│   │   ├── AnchorNav.tsx             # 模块侧边导航（卡片锚点/页面切换）
│   │   ├── BackButton.tsx            # 返回按钮组件
│   │   ├── CategoryCard.tsx          # 垃圾分类卡片（含虚拟列表）
│   │   ├── ConfirmDialog.tsx         # 确认对话框
│   │   ├── DashboardHeader.tsx       # 仪表盘头部
│   │   ├── DiskUsage.tsx             # 磁盘使用情况展示
│   │   ├── EmptyState.tsx            # 空状态引导页
│   │   ├── ErrorAlert.tsx            # 错误提示组件
│   │   ├── ModuleCard.tsx            # 通用模块卡片
│   │   ├── PageTransition.tsx        # 页面过渡动画
│   │   ├── ScanProgress.tsx          # 扫描进度组件
│   │   ├── ScanSummary.tsx           # 扫描结果摘要
│   │   ├── SettingsModal.tsx         # 设置弹窗（通用/反馈/关于）
│   │   ├── ThemeToggle.tsx           # 主题切换按钮
│   │   ├── TitleBar.tsx              # 自定义标题栏
│   │   ├── Toast.tsx                 # 轻提示通知组件
│   │   ├── UpdateModal.tsx           # 更新弹窗
│   │   ├── WelcomeModal.tsx          # 欢迎弹窗
│   │   └── index.ts                  # 组件统一导出
│   ├── contexts/
│   │   ├── DashboardContext.tsx      # 仪表盘状态管理
│   │   ├── FontSizeContext.tsx       # 字号设置状态管理
│   │   ├── SettingsContext.tsx       # 应用设置状态管理
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
│   │   ├── PlaceholderPage.tsx       # 占位页面
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
│   │   │   ├── scan_engine.rs        # 扫描引擎核心逻辑
│   │   │   ├── social_scanner.rs     # 社交软件缓存扫描器
│   │   │   ├── hotspot.rs            # 大目录分析（语义识别）
│   │   │   ├── mft_core.rs           #   MFT 共享核心（设备/USN/路径）
│   │   │   ├── hotspot_engine/       #   大目录分析引擎集合
│   │   │   │   ├── mft_scanner.rs    #     MFT 目录聚合
│   │   │   │   ├── fallback_scanner.rs#     jwalk 降级方案
│   │   │   │   └── engine_selector.rs#     引擎自动选择
│   │   │   ├── big_files_engine/     #   大文件扫描引擎集合
│   │   │   │   ├── mft_core.rs       #     MFT 枚举+路径重建
│   │   │   │   └── mft_bigfiles.rs   #     USN+$MFT 顺序解析 Top-N 扫描
│   │   │   ├── leftovers.rs          # 卸载残留扫描（置信度评分引擎）
│   │   │   ├── registry.rs           # 注册表残留扫描 (HKCR\Applications)
│   │   │   ├── registry_scoring.rs    # 路径解析 / 存在性缓存 / 安全过滤
│   │   │   └── context_menu.rs       # 右键菜单扫描与清理
│   │   ├── disk_growth/              # C 盘全盘变化分析
│   │   │   ├── mod.rs                #   模块入口
│   │   │   ├── mft_scan.rs           #   MFT 枚举 + 目录聚合
│   │   │   ├── snapshot.rs           #   全盘快照保存与读取
│   │   │   └── growth.rs             #   快照变化对比
│   │   ├── cleaner/                  # 清理器模块
│   │   │   ├── mod.rs
│   │   │   ├── delete_engine.rs      # 删除引擎（含安全保护）
│   │   │   ├── enhanced_delete.rs    # 增强删除（所有权获取）
│   │   │   └── permanent_delete.rs   # 永久删除（绕过回收站）
│   │   ├── logger/                   # 日志模块
│   │   ├── commands/                  # Tauri 命令层（按功能域拆分）
│   │   │   ├── mod.rs                 #   模块入口 + 统一 re-export
│   │   │   ├── disk.rs               #   磁盘信息
│   │   │   ├── scan.rs               #   垃圾扫描 + 大文件扫描
│   │   │   ├── social.rs             #   社交软件专清
│   │   │   ├── delete.rs             #   文件删除（基础/增强/永久）
│   │   │   ├── system.rs             #   系统瘦身 + 健康评分 + 系统信息
│   │   │   ├── leftovers.rs          #   卸载残留
│   │   │   ├── registry.rs           #   注册表 + 右键菜单清理
│   │   │   ├── hotspot.rs            #   大目录分析 + 下钻
│   │   │   ├── disk_growth.rs        #   C 盘全盘变化分析
│   │   │   ├── tools.rs              #   系统工具
│   │   │   ├── logger_cmd.rs         #   清理日志
│   │   │   └── data.rs               #   数据目录管理
│   │   ├── lib.rs                    # 应用库入口
│   │   └── main.rs                   # 应用主入口
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
├── public/                           # 公共资源
│   └── assets/                       # 截图等资源
│
├── .tauri/                           # Tauri 签名密钥（勿提交）
│   ├── update.key                    # 私钥（.gitignore）
│   └── update.key.pub                # 公钥
│
├── .github/
│   └── workflows/
│       └── release.yml               # GitHub Actions 发布流程
│
├── package.json
├── vite.config.ts
├── tsconfig.json
├── CHANGELOG.md                        # 版本更新日志
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

1. 同步版本号：`package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
2. 更新 `CHANGELOG.md` 和 `.github/workflows/release.yml` 的发布说明
3. 参考项目内 `skills/lightc-release/SKILL.md` 执行发版前检查，确保版本号、发布说明和 README 行为描述一致
4. 构建并签名
5. 上传到 GitHub Releases：
   - `LightC_x.x.x_x64-setup.nsis.zip`
   - `LightC_x.x.x_x64-setup.nsis.zip.sig`
   - `latest.json`（构建时自动生成）
   - `LightC_webview2_offline_x64.exe`（内置 WebView2 离线安装器，适合 WebView2 环境异常或安装时网络受限的用户）
   - `LightC_portable_x64.zip`（便携包内包含 `LightC.portable` 标记文件，用于禁用安装器式自动更新）
   - `LightC_installer_exe.sig`（安装版用于校验当前 `LightC.exe` 的官方签名，格式与 updater 的 base64 签名字符串一致）
   - `LightC_portable_exe.sig`（便携版解压后用于校验当前 `LightC.exe` 的官方签名，格式与 updater 的 base64 签名字符串一致）
   - `download.json`（官方渠道配置，便携版更新入口和设置页会动态读取作者网盘等链接）

### 便携版更新策略

- 安装版保留 Tauri 自动更新，继续使用 `latest.json` 和签名包完成更新；WebView2 异常或安装时网络受限的用户可改用 `LightC_webview2_offline_x64.exe`。
- 完整性校验不复用更新包签名，而是读取当前版本 Release 中的 exe 专用签名资产，避免把 zip/updater 包签名误用于运行中 exe。
- 便携版由发布流程写入 `LightC.portable` 标记文件，运行时识别后不会自动弹出更新安装器。
- 便携版“检查更新”入口会优先读取 Release 的 `download.json` 并打开作者网盘下载页，用户下载新版 zip 后覆盖当前目录即可；读取失败时降级到 GitHub Releases。

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
- **系统组件存储**：检查阶段调用 `dism.exe /online /cleanup-image /analyzecomponentstore /quiet` 做短超时估算并缓存结果；清理阶段调用 `dism.exe /online /cleanup-image /startcomponentcleanup /resetbase`
- **虚拟内存**：读取注册表检测分页文件位置，打开系统属性高级设置

---

## 📋 更新日志

查看完整的版本更新历史：[更新日志](CHANGELOG.md)

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

LightC 自 v2.10.3 起采用 [LightC Source Available License v1.0](LICENSE)。

LightC 公开源码的目的，是让用户可以审计代码、确认软件行为透明可信，并让开发者能够阅读、学习、Fork、修改源码和向官方仓库提交 Pull Request。

这不是 OSI 定义下的 Open Source License。该许可证允许：

- 阅读、审计和学习源码
- 为个人、教育、研究、安全审计或非商业开发目的复制、运行和修改源码
- Fork 项目以准备改动或向官方仓库提交贡献
- 向官方仓库提交 Issue、补丁和 Pull Request

该许可证禁止：

- 将 LightC 或其修改版本作为独立产品发布
- 改名、换标、二次打包或发布非官方版本
- 销售、出租、托管、再许可或以其他方式商业化 LightC
- 将 LightC 作为商业产品、付费服务、捆绑软件或专有发行的一部分再分发
- 删除、隐藏或修改版权、许可证、作者署名、官方渠道或安全校验相关信息

v2.10.3 之前已经发布的版本仍按其发布时附带的 MIT License 授权；自 v2.10.3 起的新版本适用 LightC Source Available License v1.0。作者保留未来提供 Pro、Enterprise 或其他商业许可版本的权利。

---

<p align="center">
  <sub>Light 代表轻量、轻快，寓意让您的C盘变得轻盈；C 即C盘，Windows系统的核心磁盘。</sub>
</p>
