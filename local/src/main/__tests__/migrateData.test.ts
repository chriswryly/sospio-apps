import { afterEach, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateChatData } from "../migrateData";

vi.mock("node:fs", async original => {
  const filesystem = await original<typeof import("node:fs")>();
  return {...filesystem, cpSync: vi.fn(filesystem.cpSync)};
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
  vi.clearAllMocks();
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "chat-migration-")); roots.push(root);
  return {root, previous: join(root, "sospio-local"), current: join(root, "Sospio Chat")};
}
it("does nothing when the earlier dev data folder does not exist", () => {
  const data = fixture(); migrateChatData(data.root);
  expect(existsSync(data.current)).toBe(false); expect(cpSync).not.toHaveBeenCalled();
});
it("copies saved settings and records once, preserving the earlier dev folder", () => {
  const data = fixture(); mkdirSync(join(data.previous, "sessions"), {recursive: true});
  writeFileSync(join(data.previous, "monitor-settings.json"), "encrypted fixture");
  writeFileSync(join(data.previous, "sessions", "fixture.jsonl"), "fixture record");
  const timestamp = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(data.previous, "sessions", "fixture.jsonl"), timestamp, timestamp);
  migrateChatData(data.root); migrateChatData(data.root);
  for (const directory of [data.previous, data.current]) {
    expect(readFileSync(join(directory, "monitor-settings.json"), "utf8")).toBe("encrypted fixture");
    expect(readFileSync(join(directory, "sessions", "fixture.jsonl"), "utf8")).toBe("fixture record");
    expect(statSync(join(directory, "sessions", "fixture.jsonl")).mtimeMs).toBe(timestamp.getTime());
  }
  expect(cpSync).toHaveBeenCalledTimes(2);
});
it("never overwrites an existing destination, even when it is empty", () => {
  const data = fixture(); mkdirSync(data.previous); mkdirSync(data.current);
  writeFileSync(join(data.previous, "monitor-settings.json"), "old fixture");
  migrateChatData(data.root);
  expect(cpSync).not.toHaveBeenCalled(); expect(existsSync(join(data.current, "monitor-settings.json"))).toBe(false);
  writeFileSync(join(data.current, "monitor-settings.json"), "new fixture");
  migrateChatData(data.root);
  expect(readFileSync(join(data.current, "monitor-settings.json"), "utf8")).toBe("new fixture");
});
it("preserves the old folder and permits retry after a failed partial copy", () => {
  const data = fixture(); mkdirSync(data.previous);
  writeFileSync(join(data.previous, "monitor-settings.json"), "encrypted fixture");
  vi.mocked(cpSync).mockImplementationOnce(() => {
    writeFileSync(join(data.current, "partial"), "fixture"); throw new Error("fixture copy failure");
  });
  expect(() => migrateChatData(data.root)).toThrow("chat_data_migration_failed");
  expect(existsSync(data.current)).toBe(false);
  expect(readFileSync(join(data.previous, "monitor-settings.json"), "utf8")).toBe("encrypted fixture");
  migrateChatData(data.root);
  expect(readFileSync(join(data.current, "monitor-settings.json"), "utf8")).toBe("encrypted fixture");
});
