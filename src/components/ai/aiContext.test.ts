// ============================================================================
// AI 助手：「用户是不是在要求动手」的判断
//
// 这道判断决定要不要把「勾选 / 删除」工具声明给模型，判错的方向必须是**少给**：
// 查询出来的数据、助手自己的话都不能被当成用户的指令。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildRequestMessages, looksLikeActionRequest } from './aiContext';
import type { AiChatMessage } from '../../types/ai';

const user = (content: string): AiChatMessage => ({ role: 'user', content });
const assistant = (content: string): AiChatMessage => ({ role: 'assistant', content });
/** 模块查出来的数据：历史里是 assistant，发请求时会被转成用户侧消息 */
const toolOutput = (content: string): AiChatMessage => ({
  role: 'assistant',
  content,
  localToolOutput: true,
});

describe('looksLikeActionRequest', () => {
  it('用户明确要求删除 / 勾选时算', () => {
    expect(looksLikeActionRequest([user('帮我看看回收站')], '帮我把回收站删了')).toBe(true);
    expect(looksLikeActionRequest([assistant('共 3 项')], '把可以安全删的都勾上')).toBe(true);
    expect(looksLikeActionRequest([], 'Please delete the temp files')).toBe(true);
  });

  it('用户只是在了解情况时不算', () => {
    expect(looksLikeActionRequest([user('这里有什么')], '那缓存呢？')).toBe(false);
    expect(looksLikeActionRequest([], '这个文件夹是做什么用的？')).toBe(false);
    expect(looksLikeActionRequest([], 'What is this folder for?')).toBe(false);
  });

  it('带「删」字的提问按既有取舍会放行，由提示词负责劝住模型', () => {
    expect(looksLikeActionRequest([], '回收站能删吗？')).toBe(true);
  });

  it('助手上一条回复里的「不建议删除」不会打开这道闸', () => {
    const history = [user('这是什么'), assistant('这些文件不建议删除，属于系统缓存。')];
    expect(looksLikeActionRequest(history, '明白了，它们占多少空间？')).toBe(false);
  });

  it('工具查出来的数据里带「清理」不算用户说过（Issue：闸被查询结果打开）', () => {
    const history = [
      user('这个分类里有什么'),
      toolOutput('路径：C:\\Windows\\SoftwareDistribution\\Download\n所属分类：Windows 更新清理'),
    ];
    // 真实的发送路径：工具结果会被转成用户侧消息。判断必须不受它影响。
    const converted = buildRequestMessages([...history, user('那它安全吗？')], 'junk-clean', null, 'p1');
    expect(converted.some((message) => message.role === 'user' && message.content.includes('所属分类'))).toBe(true);
    expect(looksLikeActionRequest(history, '那它安全吗？')).toBe(false);
  });

  it('只看最近两条用户消息，更早的指令不会一直生效', () => {
    const history = [user('把回收站删了'), assistant('已处理'), user('谢谢'), assistant('不客气')];
    expect(looksLikeActionRequest(history, '顺便问下缩略图是什么')).toBe(false);
  });
});
