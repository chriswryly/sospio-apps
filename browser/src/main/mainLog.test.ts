import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newMainLogPath } from './mainLog';
import { RetentionController } from '../../../records/retentionController';

it('expires previous and legacy main logs, deletes closed fresh logs, and protects the current launch', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'main-log-'));
  try {
    const previous = newMainLogPath(root), current = newMainLogPath(root), fresh = newMainLogPath(root), legacy = join(root, 'harness-main.log');
    expect(new Set([previous, current, fresh]).size).toBe(3);
    const now = Date.now(), old = new Date(now - 366 * 86400000);
    for (const path of [previous, current, legacy]) { writeFileSync(path, 'metadata'); utimesSync(path, old, old); }
    writeFileSync(fresh, 'recent');
    const controller = new RetentionController(() => [{path: root, kind: 'sessions'}], () => ({now, protectedPaths: [current]}));
    controller.sweep();
    expect(existsSync(previous)).toBe(false); expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(true); expect(existsSync(fresh)).toBe(true);
    controller.deleteAll();
    expect(existsSync(fresh)).toBe(false); expect(existsSync(current)).toBe(true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
