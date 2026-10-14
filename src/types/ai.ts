// ============================================================================
// AI 助手 - 前端类型
//
// 与 src-tauri/src/ai/ 下的 Rust 结构一一对应（camelCase）。
// ⚠️ 这里**没有**密钥字段：后端只返回掩码，前端拿不到明文 Key。
// ============================================================================

/** 服务商使用的协议族。目前只需区分这两种，其余服务商都归入 OpenAI 兼容。 */
export type AiProtocol = 'openAi' | 'anthropic';

/** 内置服务商预设（由后端下发，前端不做硬编码）。 */
export interface AiProviderPreset {
  id: string;
  name: string;
  protocol: AiProtocol;
  /** 默认接口地址（不带结尾斜杠） */
  baseUrl: string;
  /** 默认模型，仅作提示 */
  defaultModel: string;
  /** 本地推理：界面据此提示"数据不会离开本机" */
  local: boolean;
}

/** 后端返回给界面的配置视图：密钥已掩码。 */
export interface AiPublicConfig {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  /** 自定义 AI 数据目录；为空表示跟随主数据目录（默认位置） */
  dataDir: string;
}

/**
 * 保存配置时的提交体。
 * `apiKey` 传空字符串表示"不改动已保存的密钥" ——
 * 否则用户每次只想换个模型，都得把密钥重新粘贴一遍。
 */
export interface AiConfigInput {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 空字符串表示"改回默认位置" */
  dataDir: string;
}

/** 对话消息。role 用 OpenAI 的写法（system / user / assistant），Anthropic 由后端转译。 */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  /** 单次覆盖模型；不传则用设置里保存的 */
  model?: string;
  temperature?: number;
}

export interface AiChatReply {
  content: string;
  model: string;
}
