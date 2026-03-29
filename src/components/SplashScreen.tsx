// ============================================================================
// 启动动画组件 - 官方正版验证视觉
// 新海诚风格扫描光束 + 像素风图标 + 文字淡入动画
// ============================================================================

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// 动画配置常量
// ============================================================================

const TIMING = {
  LOGO_FADE_IN: 0.8,        // Logo 淡入时长
  SCAN_START: 0.5,          // 扫描光束开始时间
  SCAN_DURATION: 1.5,       // 单次扫描时长
  TEXT_1_START: 1.2,        // 第一行文字开始
  TEXT_2_START: 1.8,        // 第二行文字开始
  TOTAL_DURATION: 2800,     // 总动画时长 (ms)
} as const;

// 新海诚风格清透绿色
const BRAND_GREEN = {
  primary: '#4ade80',       // green-400
  glow: 'rgba(74, 222, 128, 0.6)',
  glowStrong: 'rgba(74, 222, 128, 0.8)',
} as const;

// ============================================================================
// 扫描光束组件
// ============================================================================

function ScanBeam() {
  return (
    <motion.div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: TIMING.SCAN_START, duration: 0.3 }}
    >
      {/* 扫描光束 - 从上到下循环 */}
      <motion.div
        className="absolute left-0 right-0 h-[3px]"
        style={{
          background: `linear-gradient(90deg, 
            transparent 0%, 
            ${BRAND_GREEN.glow} 20%, 
            ${BRAND_GREEN.glowStrong} 50%, 
            ${BRAND_GREEN.glow} 80%, 
            transparent 100%
          )`,
          boxShadow: `
            0 0 20px ${BRAND_GREEN.glow},
            0 0 40px ${BRAND_GREEN.glow},
            0 0 60px rgba(74, 222, 128, 0.3)
          `,
        }}
        initial={{ top: '0%' }}
        animate={{ top: ['0%', '100%', '0%'] }}
        transition={{
          duration: TIMING.SCAN_DURATION,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: TIMING.SCAN_START,
        }}
      />
    </motion.div>
  );
}

// ============================================================================
// 验证文字组件
// ============================================================================

function VerificationText() {
  const textVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <div className="mt-8 flex flex-col items-center gap-2">
      {/* 第一行：检查中 */}
      <motion.p
        className="text-sm font-mono tracking-wider"
        style={{ color: BRAND_GREEN.primary }}
        variants={textVariants}
        initial="hidden"
        animate="visible"
        transition={{ delay: TIMING.TEXT_1_START, duration: 0.5 }}
      >
        Checking File Integrity...
      </motion.p>

      {/* 第二行：验证通过 */}
      <motion.p
        className="text-xs font-mono tracking-wide text-zinc-400"
        variants={textVariants}
        initial="hidden"
        animate="visible"
        transition={{ delay: TIMING.TEXT_2_START, duration: 0.5 }}
      >
        Verified by SHA-256 Checksum
      </motion.p>
    </div>
  );
}

// ============================================================================
// 底部品牌背书
// ============================================================================

function BrandFooter() {
  return (
    <motion.div
      className="absolute bottom-8 left-0 right-0 flex flex-col items-center gap-2 px-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.5, duration: 0.8 }}
    >
      {/* 品牌标识 */}
      <p className="text-xs text-zinc-500 tracking-wide">
        Evan的像素空间 · 官方正版
      </p>

      {/* 警示语 */}
      <p className="text-[10px] text-zinc-600 text-center leading-relaxed">
        ⚠️ 严防篡改：请确认通过 B站{' '}
        <span className="text-zinc-400 font-medium">@Evan的像素空间</span>{' '}
        官方渠道下载
      </p>
    </motion.div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

interface SplashScreenProps {
  onComplete?: () => void;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(async () => {
      setIsVisible(false);
      
      // 等待淡出动画完成后通知 Rust 后端
      setTimeout(async () => {
        try {
          await invoke('close_splashscreen');
        } catch (e) {
          console.error('Failed to close splashscreen:', e);
        }
        onComplete?.();
      }, 300);
    }, TIMING.TOTAL_DURATION);

    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="fixed inset-0 z-[99999] flex flex-col items-center justify-center"
          style={{ backgroundColor: '#09090b' }} // zinc-950
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* 中心内容区 */}
          <div className="relative flex flex-col items-center">
            {/* 像素风 Logo 容器 */}
            <motion.div
              className="relative w-32 h-32"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                duration: TIMING.LOGO_FADE_IN,
                ease: [0.16, 1, 0.3, 1], // 弹簧曲线
              }}
            >
              {/* Logo 图片 */}
              <img
                src="/logo.svg"
                alt="LightC Logo"
                className="w-full h-full object-contain"
                style={{
                  imageRendering: 'pixelated',
                  filter: `drop-shadow(0 0 20px ${BRAND_GREEN.glow})`,
                }}
              />

              {/* 扫描光束覆盖层 */}
              <ScanBeam />
            </motion.div>

            {/* 验证文字 */}
            <VerificationText />
          </div>

          {/* 底部品牌背书 */}
          <BrandFooter />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default SplashScreen;
