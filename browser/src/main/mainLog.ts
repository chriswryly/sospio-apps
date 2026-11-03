import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function newMainLogPath(sessionsDir: string): string {
  return join(sessionsDir, `harness-main-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`);
}
