// ============================================================================
// 回到顶部按钮
// 当主内容滚动到一定距离后缓慢出现，点击后平滑回到顶部
// ============================================================================

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

interface BackToTopButtonProps {
  /** 主内容滚动容器；使用传入 ref 是为了同时兼容卡片模式和页面模式的内部滚动区。 */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** 超过该滚动距离后显示按钮，默认避开刚进入页面时的轻微滚动误触。 */
  threshold?: number;
}

export function BackToTopButton({ scrollContainerRef, threshold = 360 }: BackToTopButtonProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateVisibility = () => {
      setVisible(container.scrollTop > threshold);
    };

    updateVisibility();
    container.addEventListener('scroll', updateVisibility, { passive: true });
    return () => container.removeEventListener('scroll', updateVisibility);
  }, [scrollContainerRef, threshold]);

  const handleBackToTop = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // 使用原生 smooth scroll，避免自己逐帧计算造成长列表页面额外负担。
    container.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    // top-1/2
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          onClick={handleBackToTop}
          className="
            fixed right-8 bottom-10 z-50 flex h-8 w-8 items-center justify-center rounded-lg
            border border-[var(--brand-green-20)] bg-[var(--bg-card)]/95 text-[var(--brand-green)]
            shadow-lg shadow-black/10 backdrop-blur-md transition-colors
            hover:border-[var(--brand-green)] hover:bg-[var(--brand-green)] hover:text-white
            active:scale-95
          "
          title="回到顶部"
          aria-label="回到顶部"
          initial={{ opacity: 0, y: 16, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.94 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <ArrowUp className="h-5 w-5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

export default BackToTopButton;
