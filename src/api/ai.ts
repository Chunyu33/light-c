// ============================================================================
// AI 助手 - 前端调用层
//
// 只做 invoke 包装，不做任何业务判断：网络请求、密钥管理、协议适配全在后端。
// ⚠️ 这里永远不会拿到明文 API Key。
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AiChatReply,
  AiChatRequest,
  AiProfileInput,
  AiProviderPreset,
  AiPublicConfig,
} from '../types/ai';

/** 取内置服务商预设列表（设置页下拉框用）。 */
export async function listAiProviders(): Promise<AiProviderPreset[]> {
  return invoke<AiProviderPreset[]>('list_ai_providers');
}

/** 读当前配置（密钥为掩码形式）。 */
export async function getAiConfig(): Promise<AiPublicConfig> {
  return invoke<AiPublicConfig>('get_ai_config');
}

/**
 * 新增或更新一份服务商档案。
 * `id` 为空 = 新增；`apiKey` 为空 = 不改动已保存的密钥
 * （前端只拿得到掩码，回传不了明文，留空是唯一的"不改"表达方式）。
 */
export async function saveAiProfile(profile: AiProfileInput): Promise<AiPublicConfig> {
  return invoke<AiPublicConfig>('save_ai_profile', { profile });
}

/** 删除一份服务商档案；删掉的正好是当前档案时，后端会切到剩下的第一份。 */
export async function deleteAiProfile(profileId: string): Promise<AiPublicConfig> {
  return invoke<AiPublicConfig>('delete_ai_profile', { profileId });
}

/** 切换当前使用的服务商档案。 */
export async function setActiveAiProfile(profileId: string): Promise<AiPublicConfig> {
  return invoke<AiPublicConfig>('set_active_ai_profile', { profileId });
}

/** 设置 AI 数据目录（全局设置，不属于任何服务商）。 */
export async function setAiDataDir(dataDir: string): Promise<AiPublicConfig> {
  return invoke<AiPublicConfig>('set_ai_data_dir', { dataDir });
}

/**
 * 测试连通性并拉取可用模型列表。
 * 能成功拿到列表，说明接口地址、密钥、网络三者都通了 —— 设置页的「测试连接」用的就是它。
 */
export async function testAiConnection(): Promise<string[]> {
  return invoke<string[]>('test_ai_connection');
}

/** 发一次对话（非流式）。模块上下文注入属于后续阶段。 */
export async function aiChat(request: AiChatRequest): Promise<AiChatReply> {
  return invoke<AiChatReply>('ai_chat', { request });
}

/** 流式增量的推送数据体，与后端 commands/ai.rs 的 AiStreamDelta 对应。 */
export interface AiStreamDelta {
  streamId: string;
  text: string;
}

/**
 * 监听流式增量。返回取消监听的函数。
 *
 * 注意：调用方必须在结束（成功或失败）时取消监听 —— 否则一次对话会留下一个
 * 永久监听器，下次对话的增量就会被累加两遍。
 */
export async function listenAiStream(
  onDelta: (delta: AiStreamDelta) => void,
): Promise<() => void> {
  return listen<AiStreamDelta>('ai-stream-delta', (event) => onDelta(event.payload));
}

/**
 * 流式对话：增量通过事件推送（用于边生成边显示），
 * 命令返回时给出完整正文 —— 前端以返回值为准，事件只负责"实时感"。
 */
export async function aiChatStream(request: AiChatRequest, streamId: string): Promise<AiChatReply> {
  return invoke<AiChatReply>('ai_chat_stream', { request, streamId });
}

/** 落盘的一条会话消息，与后端 ai/session.rs 的 AiSessionMessage 对应。 */
export interface AiSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 附件文件名（存于 AI 数据目录的 attachments 下）。**只存名字，不存 base64** */
  images?: string[];
  /** Unix 毫秒时间戳 */
  at: number;
}

/**
 * 本地日期键（YYYY-MM-DD）。
 * 用本地时间手工拼，**不能用 toISOString** —— 那是 UTC，
 * 东八区晚上 8 点之后会算成"明天"，会话就会跨日错位。
 */
export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 保存一张图片附件，返回文件名。
 * 图片存成独立文件、会话里只记文件名 —— 否则 jsonl 会被 base64 撑爆。
 */
export async function saveAiAttachment(dataBase64: string, mediaType: string): Promise<string> {
  return invoke<string>('save_ai_attachment', { dataBase64, mediaType });
}

/** 读回一张附件，返回可直接放进 <img src> 的 data URL；文件不在时返回空串。 */
export async function readAiAttachment(name: string): Promise<string> {
  return invoke<string>('read_ai_attachment', { name });
}

/** 追加一条会话消息到本地文件（{AI数据目录}/ai/sessions/{模块}/{日期}.jsonl）。 */
export async function appendAiSessionMessage(
  moduleId: string,
  date: string,
  message: AiSessionMessage,
): Promise<void> {
  return invoke<void>('append_ai_session_message', { moduleId, date, message });
}

/** 清空某模块某天的会话历史。 */
export async function clearAiSession(moduleId: string, date: string): Promise<void> {
  return invoke<void>('clear_ai_session', { moduleId, date });
}

/** 读取某模块某天的会话历史；没有历史时返回空数组。 */
export async function loadAiSession(moduleId: string, date: string): Promise<AiSessionMessage[]> {
  return invoke<AiSessionMessage[]>('load_ai_session', { moduleId, date });
}
