import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function migrateChatData(appData: string): void {
  const previous = join(appData, "sospio-local");
  const current = join(appData, "Sospio Chat");
  if (existsSync(current) || !existsSync(previous)) return;
  try { mkdirSync(current, {mode: 0o700}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw new Error("chat_data_migration_failed");
  }
  try {
    for (const entry of readdirSync(previous)) {
      cpSync(join(previous, entry), join(current, entry), {recursive: true, force: false, errorOnExist: true, preserveTimestamps: true});
    }
  }
  catch {
    rmSync(current, {recursive: true, force: true});
    throw new Error("chat_data_migration_failed");
  }
}
