import { HOSTED_COPY } from "../shared/hostedCopy";
import type { HostedSpendState, ModelState } from "../shared/types";
import { availableChatModel, isHostedModel, type RuntimeConfig } from "./config";

export type ReadinessResult = {ok: boolean; setupMessage?: string; modelState: ModelState};
export async function checkModelReadiness(config: RuntimeConfig, spend?: HostedSpendState, restoredProvider?: "ollama" | "openrouter"): Promise<ReadinessResult> {
  const hosted = restoredProvider === "openrouter" || isHostedModel(config.chatModel);
  const base = {...modelState(config, "checking", false, "cold"), ...(hosted ? {chatProvider: "openrouter" as const} : {})};
  if (hosted && !availableChatModel(config, config.chatModel)) return {ok: false, setupMessage: HOSTED_COPY.unavailable, modelState: base};
  if (hosted && !config.hosted?.apiKey) return {ok: false, setupMessage: "hosted_assistant_key_required", modelState: base};
  if (hosted) return {ok: !spend?.exhausted, modelState: {...base, chatModelPresent: true}};
  try {
    const response = await fetch(`${config.ollamaUrl.replace(/\/$/, "")}/api/tags`);
    if (!response.ok) return {ok: false, setupMessage: `Ollama returned HTTP ${response.status}. Start Ollama and retry.`, modelState: {...base, ollamaHealth: "error"}};
    const payload = await response.json() as {models?: Array<{name?: string; model?: string; digest?: string}>};
    const present = payload.models?.find(model => [model.name, model.model].some(name => name === config.chatModel || name?.startsWith(`${config.chatModel}:`)));
    return {ok: Boolean(present), setupMessage: present ? undefined : `Pull required models: ollama pull ${config.chatModel}`,
      modelState: {...modelState(config, "healthy", Boolean(present), "cold"), chatModelDigest: present?.digest}};
  } catch {
    return {ok: false, setupMessage: "Ollama is not reachable. Start Ollama, then relaunch or restart the monitor.", modelState: {...base, ollamaHealth: "missing"}};
  }
}
export function modelState(config: RuntimeConfig, ollamaHealth: ModelState["ollamaHealth"], chatModelPresent: boolean, modelWarmth: ModelState["modelWarmth"]): ModelState {
  return {chatModel: config.chatModel, monitorModel: "remote", ollamaUrl: config.ollamaUrl, ollamaHealth, chatModelPresent, monitorModelPresent: true, modelWarmth};
}
