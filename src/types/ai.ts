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

/** 一份服务商档案的界面视图：密钥已掩码。 */
export interface AiPublicProfile {
  id: string;
  name: string;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  /** 上次成功拉取到的模型列表 */
  models: string[];
  modelsFetchedAt: number;
  /** 思考强度；空字符串 = 不发送该参数 */
  reasoningEffort: string;
}

/** 后端返回给界面的配置视图：多份档案 + 当前选中。 */
export interface AiPublicConfig {
  activeProfileId: string;
  profiles: AiPublicProfile[];
  /** 自定义 AI 数据目录；为空表示跟随主数据目录（全局设置，不属于某份档案） */
  dataDir: string;
  /** 解析后的真实目录，界面直接显示并支持一键打开 */
  resolvedDataDir: string;
}

/**
 * 提交一份档案。
 * `id` 为空 = 新增；`apiKey` 为空 = 不改动已保存的密钥
 * （前端只拿得到掩码，回传不了明文，留空是唯一的"不改"表达方式）。
 */
export interface AiProfileInput {
  /** 思考强度；空字符串 = 不发送该参数（默认）。并非所有模型都支持 */
  reasoningEffort: string;
  id: string;
  name: string;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 对话消息。role 用 OpenAI 的写法（system / user / assistant），Anthropic 由后端转译。 */
/**
 * 图片附件（已压缩，见 components/ai/imageAttach.ts）。
 * 只在**发送**时携带：历史与显示仍以 content 为准。
 */
export interface AiChatImage {
  /** 例如 image/jpeg */
  mediaType: string;
  /** 不带 data: 前缀的纯 base64 */
  dataBase64: string;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 图片附件；为空时按纯文本发送，与加入此功能之前的请求完全一致 */
  images?: AiChatImage[];
}

/** 模型请求调用某个工具。 */
export interface AiToolCall {
  callId: string;
  name: string;
  /** 已解析成对象的参数；解析失败时为空对象 */
  arguments: Record<string, unknown>;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  /** 单次覆盖模型；不传则用设置里保存的 */
  model?: string;
  temperature?: number;
  /**
   * 本次允许使用的工具名。
   * **由前端按「该模块登记了哪些动作」决定** —— 只分析不删除的模块不会传
   * propose_delete，模型也就看不到这个工具，无从提议删除。
   */
  tools?: string[];
}

export interface AiChatReply {
  content: string;
  model: string;
  /** 有值时表示模型想做某个动作而不是回话 */
  toolCalls?: AiToolCall[];
}
