// ============================================================================
// AI 助手 - 前端调用层
//
// 只做 invoke 包装，不做任何业务判断：网络请求、密钥管理、协议适配全在后端。
// ⚠️ 这里永远不会拿到明文 API Key。
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import type {
  AiChatReply,
  AiChatRequest,
  AiConfigInput,
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

/** 保存配置。apiKey 传空字符串表示保留已保存的密钥。 */
export async function saveAiConfig(config: AiConfigInput): Promise<AiPublicConfig> {
  return invoke<AiPublicConfig>('save_ai_config', { config });
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
