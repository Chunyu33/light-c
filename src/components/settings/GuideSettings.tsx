// ============================================================================
// 使用说明页面
// ============================================================================

import { BookOpen, Cpu, Database, FileBox, HardDrive, Layers, MessageCircle, MousePointerClick, Package, Shield, ShieldAlert, ShieldCheck, AlertTriangle, Zap } from 'lucide-react';

export function GuideSettings() {
  return (
    <div className="space-y-6">
      {/* 功能说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <BookOpen className="w-3.5 h-3.5" />
          功能说明
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--brand-green)]" />
              一键扫描
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描系统临时文件、浏览器缓存、Windows更新缓存等常见垃圾文件。扫描过程不会删除任何文件，您可以在扫描结果中选择需要清理的项目。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <FileBox className="w-4 h-4 text-[var(--brand-green)]" />
              大文件清理
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              可选择 C/D/E 等目标分区，扫描该分区中体积最大的文件；返回数量可在「功能设置 - 大文件清理」中调整。请仔细查看文件路径和类型，避免删除系统文件或重要数据。
            </p>
          </div>
          {/* <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[var(--brand-green)]" />
              磁盘信息
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              在「设置 - 磁盘信息」中查看物理磁盘型号、容量、分区空间和 Windows 报告的健康状态。该功能只读，不执行清理或修复；“未知”不代表健康或故障。
            </p>
          </div> */}
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-[var(--brand-green)]" />
              社交软件专清
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              支持<span className="font-medium">微信、QQ/NTQQ、钉钉、飞书、企业微信、Telegram</span>等主流社交软件。
              系统会<span className="text-[var(--brand-green)] font-medium">智能读取注册表</span>获取自定义存储路径，即使数据迁移到其他磁盘也能正确识别。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--brand-green)] font-medium">智能风险分级：</span>
              <span className="text-[var(--color-danger)]">聊天记录数据库</span>会被自动锁定禁止删除，
              <span className="text-[var(--color-warning)]">传输文件</span>需谨慎清理，
              <span className="text-[var(--brand-green)]">图片视频缓存</span>可安全清理。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Layers className="w-4 h-4 text-[var(--brand-green)]" />
              系统瘦身
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              管理休眠文件、Windows 组件存储、组件基线压缩和虚拟内存迁移引导等系统级功能。<span className="text-[var(--color-warning)] font-medium">此功能需要管理员权限</span>，ResetBase 深度清理会影响系统更新回滚，操作前请确认风险。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[var(--brand-green)]" />
              旧驱动清理
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              正在使用的驱动不可选，其他未关联设备的驱动需确认后处理。删除前会备份到当前数据目录，模块顶部支持一键恢复。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Package className="w-4 h-4 text-[var(--brand-green)]" />
              卸载残留
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              基于<span className="text-[var(--brand-green)] font-medium">置信度评分引擎</span>识别 AppData、ProgramData 等位置中疑似已卸载软件留下的目录，
              并结合注册表、安装历史和保护信号降低误判。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-warning)] font-medium">准确性提醒：</span>
              卸载后的目录归属无法 100% 权威判断，LightC 只做事后推断；清理前请结合路径、大小和软件使用情况自行确认。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Database className="w-4 h-4 text-[var(--brand-green)]" />
              注册表冗余
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描 Windows 注册表中的孤立键值和无效引用，包括 MUI 缓存、软件残留键等。
              <span className="text-[var(--color-warning)] font-medium">删除前会自动备份</span>，备份文件保存在用户文档目录下的 LightC_Backups 文件夹中。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <MousePointerClick className="w-4 h-4 text-[var(--brand-green)]" />
              右键菜单清理
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描 Windows 注册表中注册的右键菜单项（覆盖"任意文件""文件夹""桌面背景""磁盘驱动器"等场景），
              找出那些指向<span className="text-[var(--color-danger)] font-medium">已不存在可执行文件</span>的失效条目。
              失效菜单项虽不影响系统稳定性，但会让右键菜单显得杂乱，影响使用体验。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-warning)] font-medium">⚠ 权限提示：</span>
              注册表条目分为用户级（HKCU）和系统级（HKLM）两类。
              删除<span className="font-medium"> HKCU </span>条目无需特殊权限；
              删除<span className="font-medium"> HKLM </span>条目需要以<span className="text-[var(--color-warning)] font-medium">管理员身份运行</span>程序，否则会提示删除失败。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[var(--brand-green)]" />
              大目录分析
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              默认分析 AppData 用户数据热点；深度扫描可在模块标题旁选择目标磁盘。管理员权限下优先使用
              <span className="text-[var(--brand-green)] font-medium"> NTFS MFT</span>，失败时自动降级遍历。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              结果支持树形展示、热点下钻和最低大小阈值过滤；系统保护目录会被标记，深度扫描结果默认只用于定位，不建议直接当作可删除项。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[var(--brand-green)]" />
              磁盘变化分析
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              可选择本机固定磁盘分区，使用<span className="text-[var(--brand-green)] font-medium">NTFS MFT</span> 枚举文件记录，重建目录树并聚合目录大小。
              该能力需要管理员权限且仅支持 NTFS；每个磁盘首次扫描会建立独立基准快照，第二次扫描开始展示新增、减少和明显变化的目录。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              它只做空间变化定位，不提供一键删除。快照按盘符隔离保存，清空本地数据时也可以单独勾选某个磁盘的快照；扫描耗时主要取决于文件数量、$MFT 体积、硬盘类型和安全软件实时扫描。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[var(--brand-green)]" />
              AI 模型空间
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              自动分析 Ollama、LM Studio、ComfyUI、HuggingFace 和深度发现来源中的模型资产，优先读取平台配置和标准目录，展示总占用、最大模型、平台占比和类型分布。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              默认不会全盘扫描；绿色版 llama.cpp、Pinokio 或自建目录可开启<span className="text-[var(--brand-green)] font-medium">深度发现</span>，用 MFT 按模型文件特征补漏。该模块主要提供分析和定位，删除模型操作请谨慎使用。
            </p>
          </div>
        </div>
      </div>

      {/* 置信度评分说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <ShieldCheck className="w-3.5 h-3.5" />
          评分与安全保障
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[var(--brand-green)]" />
              置信度评分引擎
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              卸载残留模块采用加权评分模型（0.0~1.0），综合<span className="font-medium">卸载程序残留、历史安装路径、可执行文件、长时间未修改</span>等正向信号，
              以及<span className="font-medium">当前已安装应用映射、DisplayName 命中、通用目录名、共享厂商目录</span>等保护信号。
              <span className="text-[var(--brand-green)] font-medium">≥0.75 高置信度</span>用于优先提示但不默认勾选，
              <span className="text-[var(--color-warning)] font-medium">0.40~0.75 可疑项</span>供手动判断，&lt;0.40 的条目不输出。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-warning)] font-medium">准确性说明：</span>
              卸载后的目录归属无法做到 100% 权威判断，本模块只做高置信推断；所有结果默认不勾选，清理前建议结合路径、大小和软件使用情况确认。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Shield className="w-4 h-4 text-[var(--brand-green)]" />
              删除安全机制
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              <span className="font-medium">普通删除：</span>路径范围校验 + 浅层可执行文件扫描（exe/dll/sys），含可执行文件的目录自动跳过并引导使用深度清理。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-warning)] font-medium">深度清理：</span>白名单校验（19项系统保护路径）+ 可执行文件扫描（7种扩展名）+ 重启删除回退，
              检测到风险项标记为"需人工审核"，确保不会误删正在使用的软件。
            </p>
          </div>
        </div>
      </div>

      {/* 风险等级说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Shield className="w-3.5 h-3.5" />
          文件风险等级
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--brand-green)] text-white shrink-0">安全</span>
            <p className="text-xs text-[var(--text-muted)]">临时文件、缓存文件、日志文件等，删除后不影响系统和软件运行</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--brand-green)] text-white shrink-0">低风险</span>
            <p className="text-xs text-[var(--text-muted)]">媒体文件、下载内容等用户数据，删除前请确认不再需要</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)] text-white shrink-0">中等</span>
            <p className="text-xs text-[var(--text-muted)]">数据库文件、文档、压缩包等，可能包含重要数据，请谨慎删除</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)] text-white shrink-0">较高</span>
            <p className="text-xs text-[var(--text-muted)]">程序文件、配置文件等，删除可能导致软件无法正常运行</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-danger)] text-white shrink-0">高风险</span>
            <p className="text-xs text-[var(--text-muted)]">系统核心文件，<span className="text-[var(--color-danger)] font-medium">删除可能导致系统无法启动</span>，强烈建议不要删除</p>
          </div>
        </div>
      </div>

      {/* 注意事项 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          注意事项
        </h4>
        <div className="bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20 rounded-2xl p-5 space-y-2">
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 删除操作不可撤销，请在清理前仔细确认文件内容
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 建议定期备份重要数据，避免误删造成损失
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 系统瘦身功能涉及系统级操作，操作前请确保了解其影响
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 关闭休眠功能后将无法使用快速启动和休眠模式
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 普通 Windows 组件清理使用官方 StartComponentCleanup；仅 ResetBase 组件基线压缩会导致当前已安装更新无法卸载
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • <span className="text-[var(--color-danger)] font-medium">深度清理</span>会直接从磁盘永久删除文件，不经过回收站，无法恢复
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 卸载残留扫描会自动跳过包含可执行文件（.exe/.dll/.sys）的文件夹
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 注册表清理前会自动创建 .reg 备份文件，可通过双击恢复
          </p>
        </div>
      </div>

      {/* 免责声明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5" />
          免责声明
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            本软件仅提供文件扫描和删除功能，所有删除操作均由用户主动确认执行。开发者不对因使用本软件造成的任何数据丢失、系统故障或其他损失承担责任。使用本软件即表示您已了解并接受上述风险，请在操作前做好数据备份。
          </p>
        </div>
      </div>
    </div>
  );
}
