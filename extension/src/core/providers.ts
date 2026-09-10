import { z } from 'zod';

export interface ProviderPreset {
  id: string;
  /** 品牌名（中英通用） */
  name: string;
  /** OpenAI 兼容的 base_url（以 /v1 结尾则直接拼接 /chat/completions） */
  baseUrl: string;
  models: string[];
  /** 申请 API Key 的地址 */
  keyUrl?: string;
  /** 备注（简短，中英并写） */
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'kimi',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.2'],
    note: '需本地运行 Ollama 并设置 OLLAMA_ORIGINS=chrome-extension://* / Local Ollama required with OLLAMA_ORIGINS=chrome-extension://*',
  },
  {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    models: [],
    note: '填写任意 OpenAI 兼容服务的 base_url 与模型名 / Any OpenAI-compatible base_url',
  },
];

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  presetId: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z
    .string()
    .min(1)
    .refine((v) => /^https?:\/\//.test(v), 'must be an http(s) URL'),
  models: z.array(z.string().min(1)).min(1),
  activeModel: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** 依据预设生成一份新的服务商配置（不含密钥） */
export function presetToConfig(preset: ProviderPreset): ProviderConfig {
  return {
    id: crypto.randomUUID(),
    presetId: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    models: [...preset.models],
    activeModel: preset.models[0] ?? '',
    enabled: true,
  };
}
