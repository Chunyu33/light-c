// ============================================================================
// 弹窗动画预设（framer-motion）
//
// 中文说明：项目里多个弹窗各自写了一份 spring 参数（stiffness/damping），既难调也容易
// 改一处漏一处。这里统一改用 framer-motion 自带的 spring 语义参数：
//   - visualDuration：动画"看起来"用多久到达目标（秒），比 stiffness 直观；
//   - bounce：回弹强度，0 不弹、1 非常弹。
// 注意 framer-motion 的规则：一旦设置 stiffness/damping/mass，visualDuration 与 bounce
// 会被忽略，因此这里不再出现这三个物理参数。
// ============================================================================

/** 遮罩层：只做透明度渐变，避免大面积模糊层同时位移产生拖影。 */
export const MODAL_BACKDROP_MOTION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/** 弹窗卡片：轻微上移 + 放大入场，退场更快更小，符合"出现从容、消失干脆"。 */
export const MODAL_CARD_MOTION = {
  initial: { opacity: 0, y: 24, scale: 0.94 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 10, scale: 0.97 },
  transition: { type: 'spring', visualDuration: 0.32, bounce: 0.2 },
} as const;