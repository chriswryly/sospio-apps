import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two separate raw-body invariants:
 * headers and credentials are never written anywhere, and the query-string-drop
 * discipline never lapses. They are separate tests because they fail for different
 * reasons and are fixed in different places — a `Cookie` in a fixture is a capture
 * bug, a raw query string is a redaction gap at a log or record site.
 *
 * Both scan local runtime output — every fixture, every JSONL under `sessions/`,
 * every remote monitor log, and the main log — not just the committed record. That is the
 * point of the scan: a redaction lapse shows up in a live run's artifacts, and
 * `sessions/*` is gitignored, so a git-tracked-only scan would be green on exactly
 * the machine where the leak happened. A dirty local log is a real finding.
 */
const credentialShaped = /Authorization|Cookie|Bearer\s|x-api-key|s[k]-[A-Za-z0-9]/i;
const rawQuerySecret = /\?[a-z_]+=[A-Za-z0-9._-]{20,}/i;

const dirname = fileURLToPath(new URL(".", import.meta.url));
const harnessRoot = resolve(dirname, "../../../../..");
const scanRoots = [
  join(harnessRoot, "app/src/main/capture/providers/__fixtures__"),
  join(harnessRoot, "sessions"),
];
const maxOffendersPerFile = 3;

describe("credential leak scan", () => {
  it("keeps fixtures, sessions, and remote monitor logs free of credential-shaped strings", () => {
    // The match is the header name or key prefix itself, so it is safe to report.
    expect(scan(credentialShaped, (match) => match)).toEqual([]);
  });

  it("keeps fixtures, sessions, and remote monitor logs free of raw query strings", () => {
    expect(scan(rawQuerySecret, maskQueryValue)).toEqual([]);
  });
});

/**
 * Returns `path:line description` per match, so a failure names the artifact and
 * the line rather than only the file. Capped per file: a leaking log can match on
 * thousands of lines and the assertion output has to stay readable.
 */
function scan(pattern: RegExp, describeMatch: (match: string) => string): string[] {
  const offenders: string[] = [];
  for (const root of scanRoots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const file of walk(root)) {
      const path = relative(harnessRoot, file);
      const hits: string[] = [];
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const match = pattern.exec(line);
        if (match) {
          hits.push(`${path}:${index + 1} ${describeMatch(match[0])}`);
        }
      });
      offenders.push(...hits.slice(0, maxOffendersPerFile));
      if (hits.length > maxOffendersPerFile) {
        offenders.push(`${path} +${hits.length - maxOffendersPerFile} more line(s)`);
      }
    }
  }
  return offenders;
}

/** Names the parameter but never the value — the failure report is an artifact too. */
function maskQueryValue(match: string): string {
  const valueAt = match.indexOf("=") + 1;
  return `${match.slice(0, valueAt)}<${match.length - valueAt} redacted chars>`;
}

function* walk(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    yield path;
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "out" || entry === "dist") {
      continue;
    }
    yield* walk(join(path, entry));
  }
}

it("exports no credential variables or private runtime fields", async () => {
  const {vi} = await import("vitest");
  const {buildConversationExport} = await import("../../../renderer/conversationExport");
  const {exportFixture} = await import("../../../renderer/__fixtures__/conversationExport");
  const names = ["OPENROUTER_API_KEY", "remote_API_KEY", "RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY", "RSH_WEB_PASSWORD_HASH", "RSH_WEB_SESSION_SECRET",
    ...Object.keys(process.env).filter(name => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(name))];
  const secret = "synthetic-private-export-credential";
  try {
    for(const name of names)vi.stubEnv(name,secret);
    const state=exportFixture();Object.assign(state,{apiKey:secret,recordingPath:"private-recording",evidencePath:"private-evidence",rawResponse:secret,retentionDays:999});
    const result=JSON.stringify(buildConversationExport(state,{exported_at:"now",surface:"electron",app_version:"test"}));
    for(const value of [secret,"private-recording","private-evidence","retentionDays"])expect(result).not.toContain(value);
  }finally{vi.unstubAllEnvs();}
});

it("keeps remote-monitor error diagnostics free of the token and backend response text", async () => {
  const { vi } = await import("vitest");
  const { MonitorClient } = await import("../../monitorClient");
  const token = "fixture-remote-client-secret";
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({error: token}), {status: 401}));
  try {
    let message = "";
    try { await new MonitorClient({baseUrl: "https://fixture.invalid/monitor/v1", token}).health(); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toBe("Monitor unavailable: unauthorized");
    expect(message).not.toContain(token); expect(message).not.toMatch(credentialShaped);
  } finally { request.mockRestore(); }
});
