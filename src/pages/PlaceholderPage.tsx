// ============================================================================
// 占位页面组件
// 用于尚未实现的功能页面
// ============================================================================

import { BackButton } from '../components';

interface PlaceholderPageProps {
  /** 页面标题 */
  title: string;
  /** 页面描述 */
  description: string;
  /** 返回首页回调 */
  onBack: () => void;
}

export function PlaceholderPage({ title, description, onBack }: PlaceholderPageProps) {
  return (
    <>
      <BackButton onClick={onBack} />
      <section className="max-w-5xl mx-auto bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] px-6 py-8 space-y-4">
        <h2 className="text-lg font-semibold text-[var(--fg-primary)]">{title}</h2>
        <p className="text-sm text-[var(--fg-muted)]">{description}</p>
      </section>
    </>
  );
}
