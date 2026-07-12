// ============================================================================
// 意见反馈页面
// ============================================================================

import { useState } from 'react';
import { CheckCircle, Copy, ExternalLink, HelpCircle, MessageCircle, MessageSquare } from 'lucide-react';
import { SupportAuthor } from './SupportAuthor';

const QQ_GROUP = '834582563';

export function FeedbackSettings() {
  const [copiedQQ, setCopiedQQ] = useState(false);

  const handleCopyQQ = async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP);
      setCopiedQQ(true);
      setTimeout(() => setCopiedQQ(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  return (
    <div className="space-y-6">
      {/* 问题反馈 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HelpCircle  className="w-3.5 h-3.5"/>
          问题反馈
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              如果您在使用过程中遇到任何问题或有改进建议，欢迎通过以下方式联系我
            </p>
          </div>

          <div className="space-y-2">
            <a
              href="https://github.com/Chunyu33/light-c/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">GitHub Issues</p>
                  <p className="text-xs text-[var(--text-muted)]">在 GitHub 上提交问题</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-muted)]" />
            </a>

            <a
              href="mailto:1378813463@qq.com"
              className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--brand-green)] flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">邮件反馈</p>
                  <p className="text-xs text-[var(--text-muted)]">1378813463@qq.com</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-muted)]" />
            </a>
          </div>
        </div>
      </div>

      {/* 联系方式 - QQ群和微信 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <MessageCircle className="w-3.5 h-3.5" />
          交流
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-4 space-y-3">
          {/* QQ群 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]">QQ群：</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{QQ_GROUP}</span>
            </div>
            <button
              onClick={handleCopyQQ}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${copiedQQ
                  ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
                  : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
            >
              {copiedQQ ? (
                <><CheckCircle className="w-3 h-3" />已复制</>
              ) : (
                <><Copy className="w-3 h-3" />复制</>
              )}
            </button>
          </div>
          {/* 微信号 */}
          {/* <div className="flex items-center justify-between pt-3 border-t border-[var(--border-color)]">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]"> 微 信：</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{WECHAT_ID}</span>
            </div>
            <button
              onClick={handleCopyWechat}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${copiedWechat
                  ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
                  : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
            >
              {copiedWechat ? (
                <><CheckCircle className="w-3 h-3" />已复制</>
              ) : (
                <><Copy className="w-3 h-3" />复制</>
              )}
            </button>
          </div> */}
        </div>
      </div>

      {/* 支持作者 - 赞赏功能 */}
      <SupportAuthor />
    </div>
  );
}
