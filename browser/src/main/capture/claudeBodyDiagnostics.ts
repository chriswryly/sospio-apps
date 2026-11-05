import { describeBodyShape } from "./bodyShape";
import type { ParserDiagnostic } from "../../shared/types";

const PREFIX = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/";
const MAX_BYTES = 1_048_576;
const MAX_LOGS = 6;
// A streamed reply is reported once, after this long without new bytes, or when it finishes.
// StreamTimeline may stay open for the whole conversation, so waiting only for loadingFinished
// could log nothing; reporting on every chunk would spend the allowance on the first few frames.
export const CLAUDE_BODY_QUIET_MS = 1_500;
const MAX_FRAMES = 400;
type Endpoint = "PerformAction" | "StreamTimeline";
type Target = { sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> };
type Pending = { endpoint: Endpoint; contentType: string; bytes: Buffer; total: number; reported: number; timer?: ReturnType<typeof setTimeout> };

function endpoint(url: unknown): Endpoint | null {
  try {
    const parsed = new URL(String(url));
    const name = parsed.pathname.slice(PREFIX.length);
    return parsed.hostname === "claude.ai" && parsed.pathname.startsWith(PREFIX) &&
      (name === "PerformAction" || name === "StreamTimeline") ? name : null;
  } catch { return null; }
}

function contentType(headers: unknown): string {
  if (!headers || typeof headers !== "object") return "unknown";
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  // Parameters (including multipart boundaries) are not useful shape evidence.
  const mime = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
  return /^(application|text)\/[a-z0-9.+-]{1,80}$/.test(mime) ? mime : "unknown";
}

/** Only field numbers and wire types; skip all protobuf values, including nested messages. */
function protobufShape(bytes: Buffer): string {
  let offset = 0;
  const fields: string[] = [];
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error();
      const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error();
  };
  try {
    while (offset < bytes.length && fields.length < 40) {
      const tag = varint(), field = tag >> 3n, wire = Number(tag & 7n);
      if (field === 0n || field > 536870911n) throw new Error();
      if (wire === 2) {
        const size = varint(); if (size > BigInt(bytes.length)) throw new Error();
        fields.push(`field=${field} wire=2 len=${size}`); offset += Number(size);
        if (offset > bytes.length) throw new Error();
        continue;
      }
      fields.push(`field=${field} wire=${wire}`);
      if (wire === 0) varint();
      else if (wire === 1) offset += 8;
      else if (wire === 2) { const size = varint(); if (size > BigInt(bytes.length)) throw new Error(); offset += Number(size); }
      else if (wire === 5) offset += 4;
      else throw new Error();
      if (offset > bytes.length) throw new Error();
    }
    return fields.join(" ") + (offset < bytes.length ? " truncated" : "");
  } catch { return fields.join(" ") + " invalid-or-incomplete"; }
}

export function describeClaudeBody(bytes: Buffer, mime: string): string {
  if (mime.startsWith("application/connect+")) {
    const frames: string[] = [];
    let offset = 0, parsed = 0;
    while (offset + 5 <= bytes.length && parsed < MAX_FRAMES) {
      parsed++;
      const flag = bytes[offset], length = bytes.readUInt32BE(offset + 1);
      offset += 5;
      const metadata = `flag=${flag} length=${length}`;
      if (length > bytes.length - offset) { frames.push(`${metadata} incomplete`); offset = bytes.length; break; }
      const body = bytes.subarray(offset, offset + length); offset += length;
      const shape = flag & 1 ? "compressed" : (mime.endsWith("+json") || (flag & 2))
        ? describeBodyShape(body.toString("utf8")) : protobufShape(body);
      frames.push(`${metadata} {${shape}}`);
    }
    // A streamed reply is many frames of the same shape; collapse runs so later, different
    // frames (where the text may live) still fit in the log line.
    const runs: string[] = [];
    for (let i = 0; i < frames.length;) {
      const key = (frame: string) => frame.replace(/str\(\d+\)/g, "str").replace(/len=\d+/g, "len").replace(/length=\d+/g, "length");
      let j = i; while (j < frames.length && key(frames[j]) === key(frames[i])) j++;
      runs.push(j - i > 1 ? `${frames[i]} x${j - i}` : frames[i]); i = j;
    }
    return (runs.length ? `frames=${parsed} ${runs.join(" ")}` : "no-complete-frame-header") + (offset < bytes.length ? " trailing-or-truncated" : "");
  }
  if (mime === "application/proto" || mime === "application/protobuf") return protobufShape(bytes);
  return describeBodyShape(bytes.toString("utf8"));
}

/** Separate from turn assembly: no Fetch interception, transcript, or raw-body persistence. */
export class ClaudeBodyDiagnostics {
  private targets = new Map<Target, Map<string, Pending>>();
  private counts = new Map<string, number>();
  private disposed = false;
  constructor(private emit: (diagnostic: ParserDiagnostic) => void) {}

  async handle(target: Target, method: string, params: Record<string, any>): Promise<void> {
    if (this.disposed) return;
    let requests = this.targets.get(target);
    if (method === "Network.requestWillBeSent") {
      const name = endpoint(params.request?.url);
      if (!name || params.request?.method !== "POST" || !params.requestId) return;
      if (!requests) { requests = new Map(); this.targets.set(target, requests); }
      if (requests.size >= 20) requests.delete(requests.keys().next().value!);
      requests.set(params.requestId, {endpoint: name, contentType: "unknown", bytes: Buffer.alloc(0), total: 0, reported: 0});
      const mime = contentType(params.request.headers);
      try {
        const entries = params.request.postDataEntries;
        let body: Buffer;
        if (Array.isArray(entries) && entries.every(entry => typeof entry.bytes === "string")) {
          body = Buffer.concat(entries.map(entry => Buffer.from(entry.bytes, "base64")));
        } else if (typeof params.request.postData === "string") body = Buffer.from(params.request.postData);
        else if (params.request.hasPostData) {
          const result = await target.sendCommand("Network.getRequestPostData", {requestId: params.requestId}) as {postData?: string};
          body = Buffer.from(result.postData ?? "");
        } else body = Buffer.alloc(0);
        this.report(name, "request", mime, body.length, body.subarray(0, MAX_BYTES), "request_post_data");
      } catch { this.report(name, "request", mime, 0, Buffer.alloc(0), "unavailable"); }
      return;
    }
    const state = requests?.get(params.requestId);
    if (!state) return;
    if (method === "Network.responseReceived") {
      state.contentType = contentType(params.response?.headers);
      try {
        const result = await target.sendCommand("Network.streamResourceContent", {requestId: params.requestId}) as {bufferedData?: string};
        if (result.bufferedData) this.append(state, Buffer.from(result.bufferedData, "base64"));
        if (state.total) this.scheduleResponse(state);
      } catch { /* Finished-body fallback; never emit inspector exception text. */ }
    } else if (method === "Network.dataReceived" && typeof params.data === "string") {
      this.append(state, Buffer.from(params.data, "base64"));
      this.scheduleResponse(state);
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      requests!.delete(params.requestId);
      if (state.timer) clearTimeout(state.timer);
      if (state.total) { if (state.total !== state.reported) this.reportResponse(state, "streamResourceContent_finished"); }
      else {
        try {
          const result = await target.sendCommand("Network.getResponseBody", {requestId: params.requestId}) as {body?: string; base64Encoded?: boolean};
          const bytes = Buffer.from(result.body ?? "", result.base64Encoded ? "base64" : "utf8");
          this.append(state, bytes); this.reportResponse(state, "getResponseBody");
        } catch { this.report(state.endpoint, "response", state.contentType, 0, Buffer.alloc(0), "unavailable"); }
      }
    }
  }

  private append(state: Pending, bytes: Buffer): void {
    state.total += bytes.length;
    state.bytes = Buffer.concat([state.bytes, bytes.subarray(0, Math.max(0, MAX_BYTES - state.bytes.length))]);
  }
  private scheduleResponse(state: Pending): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (!this.disposed && state.total !== state.reported) this.reportResponse(state, "streamResourceContent_quiet");
    }, CLAUDE_BODY_QUIET_MS);
  }
  private reportResponse(state: Pending, source: string): void {
    state.reported = state.total;
    this.report(state.endpoint, "response", state.contentType, state.total, state.bytes, source);
  }
  private report(name: Endpoint, direction: string, mime: string, size: number, bytes: Buffer, source: string): void {
    const key = `${name}:${direction}`;
    const count = this.counts.get(key) ?? 0;
    if (this.disposed || count >= MAX_LOGS) return;
    this.counts.set(key, count + 1);
    this.emit({id: "claude-body-diagnostic", kind: "measurement", provider: "claudeai", timestamp: new Date().toISOString(),
      reason: `Claude body endpoint=${name} direction=${direction} content_type=${mime} bytes=${size} source=${source} shape=${describeClaudeBody(bytes, mime).slice(0, 4096)}${size > bytes.length ? " truncated" : ""}`});
  }
  dispose(): void {
    this.disposed = true;
    for (const requests of this.targets.values()) for (const state of requests.values()) if (state.timer) clearTimeout(state.timer);
    this.targets.clear();
  }
}
