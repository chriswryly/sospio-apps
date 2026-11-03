import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("electron", () => ({ipcMain: {handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn)}}));
import { installIpc } from "../ipc";
it("rejects untrusted senders, path names, nonstrings and oversized UTF-8 bodies before the dialog", async () => {
  const exportPath = vi.fn(async () => undefined);
  installIpc({openProvider: vi.fn(), reloadChat: vi.fn(), openDevTools: vi.fn(), restartMonitor: vi.fn(), getState: vi.fn(), exportPath, isTrusted: event => event === "trusted" as unknown});
  const save = handlers.get("harness:save-export")!;
  await expect(save("foreign", "sospio-export-browser.json", "{}")).rejects.toThrow("untrusted");
  for (const name of ["../sospio-export-test.json", "/sospio-export-test.json", "x\\sospio-export-test.json", "other.json", 2])
    await expect(save("trusted", name, "{}")).rejects.toThrow("invalid_export");
  for (const body of [4, "a".repeat(5 * 1024 * 1024 + 1), "é".repeat(3 * 1024 * 1024)])
    await expect(save("trusted", "sospio-export-test.json", body)).rejects.toThrow("invalid_export");
  expect(exportPath).not.toHaveBeenCalled();
  expect(await save("trusted", "sospio-export-test.json", "{}")).toBe(false);
});
it("writes the selected file verbatim with 0600 including an existing permissive file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "export-ipc-")), path = join(dir, "selected.json");
  const exportPath = vi.fn(async () => path);
  installIpc({openProvider: vi.fn(), reloadChat: vi.fn(), openDevTools: vi.fn(), restartMonitor: vi.fn(), getState: vi.fn(), exportPath, isTrusted: () => true});
  try {
    for (const existing of [false, true]) {
      if (existing) {rmSync(path); writeFileSync(path, "old", {mode: 0o644});}
      expect(await handlers.get("harness:save-export")!({}, "sospio-export-test.json", '{"exact":true}')).toBe(true);
      expect(readFileSync(path, "utf8")).toBe('{"exact":true}'); expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(exportPath).toHaveBeenCalledWith("sospio-export-test.json");
  } finally {rmSync(dir, {recursive: true, force: true});}
});
