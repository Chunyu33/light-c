// ============================================================================
// 液态玻璃：让模块卡的镜面反光跟着指针走
//
// 真正的液态玻璃，反光会随着观察角度变化；桌面上的"角度"就是指针位置。
// 反光本身是 CSS 画的（glass.css 里 .glass-surface 的 background-image），
// 这里只做一件事：把指针在卡片内的坐标写进 --glass-lx / --glass-ly。
//
// 性能约束（和项目里"列表行不加模糊"是同一条底线）：
//   - 监听挂在 document 上，全局只有这一个监听器；
//   - 用 requestAnimationFrame 合帧，一次移动只写一次样式；
//   - 只处理指针正下方那一块模块卡，不遍历、不查询列表。
// ============================================================================

import { useEffect } from 'react';

export function useGlassSpecular(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let frame = 0;
    let pendingEvent: PointerEvent | null = null;

    const paint = () => {
      frame = 0;
      const event = pendingEvent;
      pendingEvent = null;
      if (!event) return;

      // 指针不一定落在卡片本身（多半落在里面的按钮、文字上），要向上找到卡片
      const target = event.target;
      const surface = target instanceof Element ? target.closest<HTMLElement>('.glass-surface') : null;
      if (!surface) return;

      const rect = surface.getBoundingClientRect();
      surface.style.setProperty('--glass-lx', `${Math.round(event.clientX - rect.left)}px`);
      surface.style.setProperty('--glass-ly', `${Math.round(event.clientY - rect.top)}px`);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pendingEvent = event;
      // 同一帧内的多次移动只保留最后一次：样式写入是按帧合并的
      if (frame === 0) frame = requestAnimationFrame(paint);
    };

    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      cancelAnimationFrame(frame);
    };
  }, [enabled]);
}
