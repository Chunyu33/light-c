// ============================================================================
// 底部版权声明组件
// 增强用户正版渠道意识，防止第三方篡改分发
// ============================================================================

import { Shield } from 'lucide-react';

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="py-6 px-4 border-t border-[var(--border-color)] bg-[var(--bg-card)]">
      <div className="max-w-5xl mx-auto flex flex-col items-center gap-3">
        {/* 版权信息 */}
        <p className="text-[11px] text-[var(--text-muted)]">
          © {currentYear} LightC · Evan Lau · 保留所有权利
        </p>

        {/* 正版渠道提示 */}
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--bg-hover)]">
          <Shield className="w-3.5 h-3.5 text-[var(--brand-green)]" />
          <p className="text-[11px] text-[var(--text-secondary)]">
            官方发布渠道：
            <a className="text-[var(--brand-green)] font-medium mx-1" href="https://github.com/Chunyu33/light-c/releases" target="_blank" >GitHub Releases</a>
            ·
            <a className="text-[var(--text-muted)] mx-1" href='https://space.bilibili.com/387797235' target="_blank">B站 @Evan的像素空间</a>
            · 请勿从第三方下载站获取
          </p>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
