// ============================================================================
// AI 服务商预设
//
// 现状：国内外主流服务商（DeepSeek / 通义 / Kimi / 智谱 / 豆包 ）
// 以及本地推理（Ollama / LM Studio / vLLM）**都已经统一到 OpenAI 兼容协议**，
// 所以这里只需要两种协议实现：OpenAi 与 Anthropic。
//
// 新增一家服务商，通常只在下面的表里加一行即可，不需要改任何调用代码。
// ============================================================================

use serde::Serialize;

/// 服务商使用的协议族，决定请求体与响应体的解析方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiProtocol {
    /// OpenAI 兼容：POST {base}/chat/completions，`Authorization: Bearer`
    OpenAi,
    /// Anthropic：POST {base}/v1/messages，`x-api-key` + `anthropic-version`
    Anthropic,
}

/// 一个服务商的接入信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderPreset {
    /// 稳定标识，配置里存的就是它
    pub id: &'static str,
    /// 设置页展示名
    pub name: &'static str,
    pub protocol: AiProtocol,
    /// 默认接口地址（**不带结尾斜杠**，拼接路径时统一补）
    pub base_url: &'static str,
    /// 默认模型：**刻意全部留空**。
    ///
    /// 硬编码模型名有真实风险 —— 服务商改名或下线很常见，拉回来的列表里未必还有这个名字，
    /// 用户一保存就是个失效的模型名，调用直接报错。留空则强制从拉取结果里选。
    /// 交互上不会变差：设置页「测试连接」成功后会自动选中列表第一项；
    /// 万一拉不到列表，界面会退化成手填输入框。
    pub default_model: &'static str,
    /// 是否本地推理：界面据此提示"数据不会离开本机"
    pub local: bool,
}

/// 内置预设表。数组顺序 = 设置页展示顺序。
pub const PROVIDER_PRESETS: &[AiProviderPreset] = &[
    AiProviderPreset {
        id: "deepseek",
        name: "DeepSeek",
        protocol: AiProtocol::OpenAi,
        base_url: "https://api.deepseek.com/v1",
        default_model: "",
        local: false,
    },
    AiProviderPreset {
        id: "openai",
        name: "OpenAI",
        protocol: AiProtocol::OpenAi,
        base_url: "https://api.openai.com/v1",
        default_model: "",
        local: false,
    },
    AiProviderPreset {
        id: "moonshot",
        name: "Kimi（月之暗面）",
        protocol: AiProtocol::OpenAi,
        base_url: "https://api.moonshot.cn/v1",
        default_model: "",
        local: false,
    },
    AiProviderPreset {
        id: "dashscope",
        name: "通义千问（Qwen）",
        protocol: AiProtocol::OpenAi,
        // 百炼的 OpenAI 兼容模式专用路径，与原生 DashScope 接口不同
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "",
        local: false,
    },
    AiProviderPreset {
        id: "zhipu",
        name: "智谱 GLM",
        protocol: AiProtocol::OpenAi,
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        default_model: "",
        local: false,
    },
    AiProviderPreset {
        id: "anthropic",
        name: "Anthropic Claude",
        protocol: AiProtocol::Anthropic,
        base_url: "https://api.anthropic.com",
        // Claude 的模型名迭代较快，这里只给一个提示，以拉取结果为准
        default_model: "",
        local: false,
    },
    AiProviderPreset {
        id: "ollama",
        name: "本地 Ollama",
        protocol: AiProtocol::OpenAi,
        // Ollama 自带 OpenAI 兼容端点
        base_url: "http://127.0.0.1:11434/v1",
        default_model: "",
        local: true,
    },
    AiProviderPreset {
        id: "custom",
        name: "自定义（OpenAI 兼容）",
        protocol: AiProtocol::OpenAi,
        base_url: "",
        default_model: "",
        local: false,
    },
];

/// 提供给设置页渲染下拉框。
pub fn list_providers() -> Vec<AiProviderPreset> {
    PROVIDER_PRESETS.to_vec()
}

/// 按 id 查预设；找不到时回退到"自定义"，避免旧配置把界面打挂。
pub fn find_preset(id: &str) -> &'static AiProviderPreset {
    PROVIDER_PRESETS
        .iter()
        .find(|preset| preset.id == id)
        .unwrap_or_else(|| {
            PROVIDER_PRESETS
                .iter()
                .find(|preset| preset.id == "custom")
                .expect("预设表必须包含 custom 兜底项")
        })
}
