import { HOSTED_COPY } from "../shared/hostedCopy";
import { availableChatModel, isHostedModel, type RuntimeConfig } from "./config";
import { ChatClient, type ChatPort, type ChatRequest, type StreamResult } from "./chatClient";

export class ChatRouter implements ChatPort {
  constructor(private config: RuntimeConfig, private local: ChatPort = new ChatClient(config), private hosted?: ChatPort) {}
  async prewarm(model: string): Promise<void> {
    if (this.config.hosted?.models.some(m => m.id === model)) return;
    await this.local.prewarm(model);
  }
  async streamChat(request: ChatRequest, onChunk: (text: string) => void): Promise<StreamResult> {
    const model = availableChatModel(this.config, request.model ?? this.config.chatModel);
    if (!model && isHostedModel(request.model ?? this.config.chatModel)) throw new Error(HOSTED_COPY.unavailable);
    // Restored local transcripts historically remain usable even if their model left the picker list.
    // Restored hosted eligibility is also checked by the orchestrator using the persisted provider.
    if (model?.provider === "openrouter") {
      if (!this.hosted) throw new Error(HOSTED_COPY.unavailable);
      return this.hosted.streamChat(request, onChunk);
    }
    return this.local.streamChat(request, onChunk);
  }
}
