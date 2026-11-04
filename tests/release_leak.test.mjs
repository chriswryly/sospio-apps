import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRelease, scanText } from "../scripts/release-scan.mjs";

test("release_leak: all release source files pass", () => {
  assert.deepEqual(scanRelease(fileURLToPath(new URL("..", import.meta.url))), []);
});

test("release_leak: detects prohibited names and credential shapes", () => {
  for (const value of ["j" + "ev", "l" + "una", "t" + "ypesafe", "q" + "wen", "s" + "idecar",
    ["judge", "ladder", "private"].join("_"), "s" + "k-example", "Bear" + "er value", "a".repeat(32), "prefix" + "a".repeat(32) + "suffix"]) {
    assert.ok(scanText(value).length > 0);
  }
});

test("release_leak: only public wire identifiers are exempt", () => {
  assert.deepEqual(scanText("judge_ladder judge_ladder_verdict_v1"), []);
  for (const parts of [["judge", "ladder", "private"], ["judge", "ladder", "verdict", "v2"], ["prefix", "judge", "ladder"], ["judge", "ladder", "suffix"]]) {
    const value = parts.join("_");
    assert.ok(scanText(value).length > 0);
  }
});

test("release_leak: detects internal record names and research references", () => {
  for (const value of [
    ["INTERNAL", "RECORD"].join("_") + ".md",
    "prefix" + ["PRIVATE", "RECORD"].join("_") + ".md",
    ["PHASE", "5", "WP", "F", "FINDING"].join("_") + ".md",
    "123456" + ".md",
    "Co" + "smos",
    ["WP", "F"].join("-"),
    ["r", "sh"].join("") + "/module.ts",
    ["r", "sh"].join("") + "\\module.ts",
  ]) assert.ok(scanText(value).length > 0, value);
});

test("release_leak: permits public readmes and ordinary release references", () => {
  for (const value of ["README.md", "browser/README.md", "local/README.md", "readme.md", "settings.md", "SHORT.md", "Monitor settings", "Workflows", "judge_ladder judge_ladder_verdict_v1"]) {
    assert.deepEqual(scanText(value), [], value);
  }
  assert.ok(scanText("README.md " + ["PRIVATE", "RECORD"].join("_") + ".md").length > 0);
});

test("release_leak: scans file names as well as contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-scan-"));
  const privateName = ["INTERNAL", "RECORD"].join("_") + ".md";
  try {
    writeFileSync(join(directory, "README.md"), "Monitor settings: judge_ladder judge_ladder_verdict_v1");
    assert.deepEqual(scanRelease(directory), []);
    writeFileSync(join(directory, privateName), "Monitor settings");
    assert.deepEqual(scanRelease(directory), [`${privateName}: internal record name`]);
    rmSync(join(directory, privateName));
    writeFileSync(join(directory, "source.ts"), ["r", "sh"].join("") + "/module.ts");
    assert.deepEqual(scanRelease(directory), ["source.ts: private monitor term"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release_leak: integrity exemption is limited to lockfile integrity fields", () => {
  const lock = JSON.stringify({ packages: { example: { integrity: "a".repeat(64) } } });
  assert.deepEqual(scanText(lock, "package-lock.json"), []);
  assert.ok(scanText(lock, "source.json").length > 0);
  assert.ok(scanText(JSON.stringify({ resolved: "a".repeat(64) }), "package-lock.json").length > 0);
});

test("release_leak: allows the disclosed backend name only in the top-level README", () => {
  const name = ["J", "ev"].join("");
  const line = `As of this writing, ${name} is the principal backend which receives messages.`;
  assert.deepEqual(scanText(line, "README.md"), []);
  for (const file of ["local/README.md", "browser/README.md", "source.ts", "shared/types.ts"]) {
    assert.ok(scanText(line, file).length > 0, file);
  }
  assert.ok(scanText(`${name.toLowerCase()}_prompt`, "README.md").length > 0);
  assert.ok(scanText(`${name} prompts and the ${["l", "una"].join("")} backend`, "README.md").length > 0);
});

test("release_leak: only official full action pins in the release workflow are exempt", () => {
  const pin = "a".repeat(40), workflow = ".github/workflows/release.yml";
  for (const action of ["checkout", "setup-node", "upload-artifact", "download-artifact"]) {
    const line = `      - uses: actions/${action}@${pin}`;
    assert.deepEqual(scanText(line, workflow), []);
    assert.ok(scanText(line, "source.ts").length > 0);
    assert.ok(scanText(line, ".github/workflows/other.yml").length > 0);
  }
  for (const text of [`token: ${pin}`, `# uses: actions/checkout@${pin}`, `- uses: other/checkout@${pin}`,
    `- uses: actions/checkout@${pin}extra`, `- uses: actions/checkout@${pin} # ${pin}`,
    `- uses: actions/checkout@${pin}\nsecret: ${pin}`]) assert.ok(scanText(text, workflow).length > 0);
  assert.ok(scanText(`- uses: actions/checkout@${pin} # ${["l", "una"].join("")}`, workflow).length > 0);
});
