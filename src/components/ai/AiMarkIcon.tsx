// ============================================================================
// AI 助手标识（手绘 SVG）
//
// 为什么不用图标库：现有的 Sparkles（四角星）在项目里是「闪亮 / 新功能」的语义，
// 拿它当 AI 助手完全看不出是"能对话的助手"。
//
// 画法说明（为小尺寸做的取舍）：
//   - 20px 左右要认得出，所以只保留三块信息：方形脑袋 + 两只眼睛 + 一根天线；
//   - 与全项目图标统一用**描边**风格（不是实心块），线宽 1.75 在 24 格下方显得
//     和 Lucide 图标同一家族；
//   - 用 currentColor，跟随文字色（现在是品牌绿），换主题不用改这里。
// ============================================================================

interface AiMarkIconProps {
  className?: string;
}

export function AiMarkIcon({ className = '' }: AiMarkIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* 天线：一根竖线 + 顶端圆点，最省笔墨的"机器人"信号 */}
      <path d="M12 2.6v2.1" />
      <circle cx="12" cy="2" r="1.05" />
      {/* 脑袋：圆角矩形，比正圆更像机器人 */}
      <rect x="4" y="4.9" width="16" height="13.2" rx="4.2" />
      {/* 眼睛：两个实心圆点，是"有生命感"的关键 */}
      <circle cx="9.2" cy="11.2" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="11.2" r="1.15" fill="currentColor" stroke="none" />
      {/* 嘴：一道短线，纯描边时和眼睛一起构成表情 */}
      <path d="M9.6 14.3h4.8" />
    </svg>
  );
}
