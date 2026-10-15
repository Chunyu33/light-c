// ============================================================================
// 回到顶部按钮
// 当主内容滚动到一定距离后缓慢出现，点击后平滑回到顶部
// ============================================================================

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

interface BackToTopButtonProps {
  /** 主内容滚动容器；使用传入 ref 是为了同时兼容卡片模式和页面模式的内部滚动区。 */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** 超过该滚动距离后显示按钮，默认避开刚进入页面时的轻微滚动误触。 */
  threshold?: number;
}

export function BackToTopButton({ scrollContainerRef, threshold = 360 }: BackToTopButtonProps) {
  const { t } = useTranslation('common');
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
        /* ⚠️ 层级 z-30：**故意低于** AI 助手面板（z-40）。
           这个按钮在右下角，而助手面板展开时正好覆盖那块区域；
           原来写 z-50 会让它从面板上面"穿出来"，既挡内容、又容易误点。
           它仍高于模块内容与模块操作栏（z-20），该露脸时照常露脸。

           ⚠️ 注释位置有讲究：这里处于 {visible && ( … )} 的 JS 表达式位置，
           只能写这种形式；换成花括号包起来的 JSX 注释写法会被当成对象字面量，
           直接编不过。反过来，在 JSX 子节点位置则必须用花括号那种写法，
           否则注释会被当文本渲染到界面上。 */
        <motion.button
          type="button"
          onClick={handleBackToTop}
          className="
            glass-overlay fixed right-8 bottom-10 z-30 flex h-8 w-8 items-center justify-center rounded-lg
            border border-[var(--brand-green-20)] bg-[var(--bg-card)]/95 text-[var(--brand-green)]
            shadow-lg shadow-black/10 backdrop-blur-md transition-colors
            hover:border-[var(--brand-green)] hover:bg-[var(--brand-green)] hover:text-white
            active:scale-95
          "
          title={t('backToTop')}
          aria-label={t('backToTop')}
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
