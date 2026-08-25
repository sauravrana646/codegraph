export type EnrichmentProviderId =
  | "openai"
  | "openrouter"
  | "groq"
  | "together"
  | "fireworks"
  | "deepseek"
  | "mistral"
  | "google"
  | "custom";

export interface EnrichmentProviderPreset {
  id: EnrichmentProviderId;
  label: string;
  /** OpenAI-compatible chat completions root (no trailing slash). Empty for custom. */
  baseUrl: string;
  defaultModel: string;
  /** Suggested model ids for QuickPick presets. */
  models: string[];
  /** Whether the provider reliably accepts response_format=json_object. */
  supportsJsonObject: boolean;
  description: string;
}

export const ENRICHMENT_PROVIDER_PRESETS: readonly EnrichmentProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini"],
    supportsJsonObject: true,
    description: "OpenAI Chat Completions API"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    models: [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.0-flash-001",
      "google/gemini-2.5-pro-preview",
      "meta-llama/llama-3.3-70b-instruct"
    ],
    supportsJsonObject: true,
    description: "Route to OpenAI, Claude, Gemini, and more"
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
    supportsJsonObject: true,
    description: "Groq OpenAI-compatible endpoint"
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    models: [
      "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo"
    ],
    supportsJsonObject: true,
    description: "Together OpenAI-compatible endpoint"
  },
  {
    id: "fireworks",
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    models: [
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/qwen2p5-72b-instruct"
    ],
    supportsJsonObject: false,
    description: "Fireworks OpenAI-compatible endpoint"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    supportsJsonObject: true,
    description: "DeepSeek OpenAI-compatible endpoint"
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    models: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest", "codestral-latest"],
    supportsJsonObject: true,
    description: "Mistral OpenAI-compatible endpoint"
  },
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-pro", "gemini-1.5-pro"],
    supportsJsonObject: true,
    description: "Gemini OpenAI-compatible endpoint"
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o"],
    supportsJsonObject: false,
    description: "Any OpenAI-compatible /v1/chat/completions host"
  }
] as const;

const PRESET_BY_ID = new Map(ENRICHMENT_PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function getEnrichmentProviderPreset(
  providerId: string | undefined
): EnrichmentProviderPreset {
  if (providerId && PRESET_BY_ID.has(providerId as EnrichmentProviderId)) {
    return PRESET_BY_ID.get(providerId as EnrichmentProviderId)!;
  }
  return PRESET_BY_ID.get("openai")!;
}

/**
 * Resolve the effective OpenAI-compatible base URL for a provider selection.
 * Known providers ignore stale custom baseUrl values; custom uses the override.
 */
export function resolveEnrichmentBaseUrl(
  providerId: string | undefined,
  customBaseUrl?: string
): string {
  const preset = getEnrichmentProviderPreset(providerId);
  if (preset.id === "custom") {
    const trimmed = customBaseUrl?.trim();
    return (trimmed && trimmed.length > 0 ? trimmed : "https://api.openai.com/v1").replace(/\/$/, "");
  }
  return preset.baseUrl.replace(/\/$/, "");
}

export function defaultModelForProvider(providerId: string | undefined): string {
  return getEnrichmentProviderPreset(providerId).defaultModel;
}

export function modelPresetsForProvider(providerId: string | undefined): string[] {
  const preset = getEnrichmentProviderPreset(providerId);
  const models = [...preset.models];
  if (!models.includes(preset.defaultModel)) {
    models.unshift(preset.defaultModel);
  }
  return models;
}
