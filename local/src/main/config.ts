import hostedCatalog from "../../hosted_models.json";
import type { ChatModelChoice } from "../shared/types";
import os from "node:os";

export const DEFAULT_SYSTEM_PROMPT = "This chat may be monitored or recorded for quality assurance or testing purposes.";
export const DEFAULT_INTERVENTION_CONTEXT = "Before answering, check uncertain claims against the user's stated context and preserve explicit boundaries.";
export const DEFAULT_GOVERNOR_NOTICE = "Sospio notice: Sospio flagged the preceding turn.";
export const DEFAULT_GOVERNOR_WITHHELD = "Sospio notice: this response was withheld by Sospio.";
export const DEFAULT_GOVERNOR_REDACTION = "Sospio notice: this response was visibly redacted by Sospio.";
export const DEFAULT_GOVERNOR_REPLACEMENT = "Sospio notice: this response was replaced by Sospio.";
export const REHEARSAL_NOTICE_PREFIX = "[REHEARSAL]";
export type HostedModel = {
  id: string; label: string; vendor: string;
  prompt_usd_per_mtok: number; completion_usd_per_mtok: number;
  disable_reasoning?: boolean; reasoning_effort?: "minimal" | "low";
};
export const HOSTED_MAX_TOKENS = 1024;
export const HOSTED_MAX_PROMPT_TOKENS = 64000;
export const hostedModels: HostedModel[] = hostedCatalog.models as HostedModel[];
export type HostedConfig = {apiKey: string; capUsd: number; models: HostedModel[]};
export type RuntimeConfig = {
  hosted?: HostedConfig; chatModel: string; chatModels?: ChatModelChoice[];
  ollamaUrl: string; keepAlive: string; contextTurns: number; systemPrompt: string;
  interventionContext: string; interventionNotice: string; interventionWithheld: string;
  interventionRedaction: string; interventionReplacement: string;
};

export function loadRuntimeConfig(): RuntimeConfig {
  const hosted = loadHostedConfig();
  const chatModel = resolveChatModel();
  const localModels = resolveChatModels(process.env.RSH_LOCAL_CHAT_MODELS, chatModel);
  if ([chatModel, ...localModels.map(model => model.name)].some(name => isHostedModel(name))) throw new Error("hosted_local_model_conflict");
  return {
    ...(hosted ? {hosted} : {}), chatModel,
    chatModels: [...localModels, ...(hosted?.models.map(model => ({provider: "openrouter" as const, name: model.id, label: model.label, vendor: model.vendor})) ?? [])],
    ollamaUrl: process.env.RSH_LOCAL_OLLAMA_URL?.trim() || "http://127.0.0.1:11434",
    keepAlive: process.env.RSH_LOCAL_OLLAMA_KEEP_ALIVE?.trim() || "-1",
    contextTurns: positiveInteger(process.env.RSH_LOCAL_CHAT_CONTEXT_TURNS, 12),
    systemPrompt: process.env.RSH_LOCAL_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    interventionContext: process.env.RSH_LOCAL_INTERVENTION_CONTEXT ?? DEFAULT_INTERVENTION_CONTEXT,
    interventionNotice: process.env.RSH_LOCAL_INTERVENTION_NOTICE ?? DEFAULT_GOVERNOR_NOTICE,
    interventionWithheld: process.env.RSH_LOCAL_INTERVENTION_WITHHELD ?? DEFAULT_GOVERNOR_WITHHELD,
    interventionRedaction: process.env.RSH_LOCAL_INTERVENTION_REDACTION ?? DEFAULT_GOVERNOR_REDACTION,
    interventionReplacement: process.env.RSH_LOCAL_INTERVENTION_REPLACEMENT ?? DEFAULT_GOVERNOR_REPLACEMENT,
  };
}

export function resolveChatModel(totalMemoryBytes = os.totalmem()): string {
  return process.env.RSH_LOCAL_CHAT_MODEL?.trim() || (totalMemoryBytes >= 18 * 1024 ** 3 ? "llama3.1:8b" : "llama3.2:3b");
}
function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function isTruthy(value: string | undefined): boolean { return ["1", "true", "yes"].includes(value?.trim().toLowerCase() ?? ""); }
export function resolveChatModels(raw: string | undefined, fallback: string): ChatModelChoice[] {
  const names = [...new Set((raw ?? "").split(",").map(name => name.trim()).filter(Boolean))];
  return (names.length ? names : [fallback]).map(name => ({provider: "ollama", name}));
}
function loadHostedConfig(): HostedConfig | undefined {
  if (!isTruthy(process.env.RSH_LOCAL_HOSTED_ASSISTANT)) return undefined;
  const apiKey = process.env.RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("hosted_assistant_key_required");
  const capUsd = Number(process.env.RSH_LOCAL_ASSISTANT_CAP_USD ?? "1.00");
  if (!Number.isSafeInteger(Math.floor(capUsd * 1e9)) || Math.floor(capUsd * 1e9) <= 0 || (capUsd > 1 && process.env.RSH_LOCAL_ASSISTANT_CAP_OVERRIDE !== "1")) throw new Error("invalid_hosted_assistant_cap");
  const raw = process.env.RSH_LOCAL_HOSTED_MODELS;
  const ids = raw === undefined ? hostedModels.map(model => model.id) : [...new Set(raw.split(",").map(name => name.trim()).filter(Boolean))];
  if (!ids.length || ids.some(id => !isHostedModel(id))) throw new Error("unknown_hosted_model");
  return {apiKey, capUsd, models: ids.map(id => hostedModels.find(model => model.id === id)!)};
}
export function isHostedModel(name: string): boolean { return hostedModels.some(model => model.id === name); }
export function availableChatModel(config: RuntimeConfig, name: string): ChatModelChoice | undefined {
  const choice = (config.chatModels ?? [{provider: "ollama" as const, name: config.chatModel}]).find(model => model.name === name);
  if (choice?.provider === "openrouter" && !config.hosted?.models.some(model => model.id === name)) return undefined;
  return choice;
}
