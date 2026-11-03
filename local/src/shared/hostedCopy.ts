export const HOSTED_COPY = {
  local: "Local · Ollama",
  scenariosUrl: "https://axrlab.net/sospioscenarios.html",
  scenariosLink: "Scenarios to try",
  hostedSuffix: " (hosted)",
  localSuffix: " (local · Ollama)",
  disclosure: (vendor: string) => `Hosted · sent to OpenRouter and ${vendor}`,
  cap: (cap: number) => `Hosted assistant cap reached for this launch ($${cap.toFixed(2)}). Restart the app or start a new conversation with a local model.`,
  unavailable: "This conversation's hosted model is disabled or unavailable. Start a new conversation with a local model.",
  spend: (spent: number, cap: number) => `hosted spend $${spent.toFixed(2)} of $${cap.toFixed(2)} (estimated)`,
  promptLimit: "Hosted assistant prompt exceeds the supported limit. Start a new conversation or shorten the message.",
};
