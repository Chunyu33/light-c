// ============================================================================
// 设置弹窗组件
// 只负责弹窗生命周期、左侧导航和页面路由；具体设置页面按功能拆分维护。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTheme } from '../contexts';
import { AboutSettings } from './settings/AboutSettings';
import { FeedbackSettings } from './settings/FeedbackSettings';
import { FeatureSettings } from './settings/FeatureSettings';
import { GeneralSettings } from './settings/GeneralSettings';
import { GuideSettings } from './settings/GuideSettings';
import { SecuritySettings } from './settings/SecuritySettings';
import { DiskInfoSettings } from './settings/DiskInfoSettings';
import { SETTINGS_TABS } from './settings/constants';
import type { SettingsTab } from './settings/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { mode, setMode } = useTheme();
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  // 记录是否曾经进入可见状态，用于区分首次挂载预隐藏和关闭动画。
  const enteredRef = useRef(false);
  if (isVisible) enteredRef.current = true;

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      setIsVisible(true);
      return;
    }

    setIsVisible(false);
    const timer = setTimeout(() => setIsAnimating(false), 190);
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={onClose}
      />

      <div className={`relative h-[80vh] w-[76vw] min-h-0 min-w-0 max-h-[calc(100vh-24px)] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl bg-[var(--bg-card)] shadow-2xl ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
        <div className="flex h-full">
          <aside className="w-[160px] shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-main)] py-4">
            <div className="mb-4 px-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">设置</h2>
            </div>
            <nav className="space-y-1 px-2">
              {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${activeTab === id
                    ? 'bg-[var(--brand-green-10)] font-medium text-[var(--brand-green)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
            </nav>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-card)]">
            <div className="flex min-h-12 items-center justify-between border-b border-[var(--border-color)] px-5">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                {SETTINGS_TABS.find((tab) => tab.id === activeTab)?.label}
              </h3>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                aria-label="关闭设置"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-5">
              {activeTab === 'general' && <GeneralSettings mode={mode} setMode={setMode} />}
              {activeTab === 'features' && <FeatureSettings />}
              {activeTab === 'disk-info' && <DiskInfoSettings />}
              {activeTab === 'guide' && <GuideSettings />}
              {activeTab === 'security' && <SecuritySettings />}
              {activeTab === 'feedback' && <FeedbackSettings />}
              {activeTab === 'about' && <AboutSettings />}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default SettingsModal;
