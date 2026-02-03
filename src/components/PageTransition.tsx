// ============================================================================
// 页面过渡动画组件
// iOS 风格的滑动过渡效果
// ============================================================================

import { useEffect, useState, useRef } from 'react';

interface PageTransitionProps {
  children: React.ReactNode;
  pageKey: string;
  direction?: 'forward' | 'back';
}

export function PageTransition({ children, pageKey, direction = 'forward' }: PageTransitionProps) {
  const [displayChildren, setDisplayChildren] = useState(children);
  const [transitionStage, setTransitionStage] = useState<'idle' | 'exit' | 'enter'>('idle');
  const prevKeyRef = useRef(pageKey);

  useEffect(() => {
    if (pageKey !== prevKeyRef.current) {
      // 页面切换，开始退出动画
      setTransitionStage('exit');
      
      const exitTimer = setTimeout(() => {
        // 退出动画结束，更新内容并开始进入动画
        setDisplayChildren(children);
        setTransitionStage('enter');
        prevKeyRef.current = pageKey;
        
        const enterTimer = setTimeout(() => {
          setTransitionStage('idle');
        }, 250);
        
        return () => clearTimeout(enterTimer);
      }, 200);
      
      return () => clearTimeout(exitTimer);
    } else {
      // 同一页面，直接更新内容
      setDisplayChildren(children);
    }
  }, [children, pageKey]);

  // 根据方向和阶段计算动画类名
  const getAnimationClass = () => {
    if (transitionStage === 'idle') return '';
    
    if (transitionStage === 'exit') {
      return direction === 'forward' 
        ? 'animate-slide-out-left' 
        : 'animate-slide-out-right';
    }
    
    if (transitionStage === 'enter') {
      return direction === 'forward' 
        ? 'animate-slide-in-right' 
        : 'animate-slide-in-left';
    }
    
    return '';
  };

  return (
    <div className={`w-full h-full ${getAnimationClass()}`}>
      {displayChildren}
    </div>
  );
}
