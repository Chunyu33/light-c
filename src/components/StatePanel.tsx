// ============================================================================
// 居中状态面板
//
// 只做一件事：在模块正文里摆一块**整体居中、内部文字左对齐**的内容列。
//
// 【为什么文字不居中】
// 标题 + 统计 + 细项这种 3~4 行的内容，行长度差很多（"成功释放 67.9 MB，352.7 MB 跳过，
// 42 个文件将在重启后删除" vs "成功 949 个"）。文字居中时每一行都要重新找中轴，
// 眼睛得左右来回跳；左对齐之后行首对齐，读起来是一段话。所以是"块居中、字靠左"。
//
// 【谁在用】
// 「删除中」（ModuleDeleteProgress 的 block 形态）和「清理完成」（ScanSummary 的结果区）。
// 这两个状态是同一件事的前后两步，几何必须一模一样，只换图标和文案 ——
// 共用这个外壳就是防止它们再次各画一套（上一版一个是玫红色块、一个是 65vh 绿带，
// 同一屏里三种视觉语言）。
// ============================================================================

import type { ReactNode } from 'react';

interface StatePanelProps {
  children: ReactNode;
}

export function StatePanel({ children }: StatePanelProps) {
  return (
    // `module-scan-progress-area` 只提供最小高度兜底；`flex-1` 让页面模式铺满卡片正文，
    // 内容在里面垂直居中 —— 不要在内部再写 min-height 去凑高度。
    <div className="module-scan-progress-area flex flex-1 items-center justify-center p-6">
      {/* 列宽上限按"一行能读完一句中文"取的，太宽行长会散 */}
      <div className="w-full max-w-[34em]">{children}</div>
    </div>
  );
}

export default StatePanel;
