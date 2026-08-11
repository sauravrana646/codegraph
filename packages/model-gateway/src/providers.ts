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
    supportsJsonObject: true,
    description: "OpenAI Chat Completions API"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    supportsJsonObject: true,
    description: "Route to OpenAI, Claude, Gemini, and more"
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    supportsJsonObject: true,
    description: "Groq OpenAI-compatible endpoint"
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    supportsJsonObject: true,
    description: "Together OpenAI-compatible endpoint"
  },
  {
    id: "fireworks",
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    supportsJsonObject: false,
    description: "Fireworks OpenAI-compatible endpoint"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    supportsJsonObject: true,
    description: "DeepSeek OpenAI-compatible endpoint"
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    supportsJsonObject: true,
    description: "Mistral OpenAI-compatible endpoint"
  },
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    supportsJsonObject: true,
    description: "Gemini OpenAI-compatible endpoint"
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    defaultModel: "gpt-4o-mini",
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
