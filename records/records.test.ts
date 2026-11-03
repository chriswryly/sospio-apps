import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retentionDays, startRetention, sweepRoot } from './recordsRetention';
import { recordsDisclosure, recordsSummary } from './disclosure';
import { recordsInfo } from './recordsConfig';

const directories: string[] = [];
const now = Date.UTC(2026, 10, 3);
function directory(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'records-test-'));
  directories.push(path);
  return path;
}
function oldFile(path: string): void {
  writeFileSync(path, 'PRIVATE CONVERSATION');
  const old = new Date(now - 20 * 86400000);
  utimesSync(path, old, old);
}
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('keeps the default retention and validates configured days', () => {
  expect(retentionDays()).toBe(14);
  expect(retentionDays('365')).toBe(365);
  for (const value of ['0', '366', '-1', '1.5', '', ' 14', '1e2']) expect(() => retentionDays(value)).toThrow('invalid_records_retention_days');
});

it('deletes expired conversation and log files while protecting the active recording', () => {
  const path = directory();
  oldFile(join(path, 'expired.jsonl'));
  oldFile(join(path, 'active.jsonl'));
  oldFile(join(path, 'expired.log'));
  writeFileSync(join(path, 'fresh.jsonl'), 'fresh');
  mkdirSync(join(path, 'nested'));
  oldFile(join(path, 'nested', 'protected.jsonl'));
  const result = sweepRoot({ path, kind: 'sessions' }, { days: 14, now, protectedPaths: [join(path, 'active.jsonl')] });
  expect(result.removed.A.count).toBe(2);
  expect(existsSync(join(path, 'expired.jsonl'))).toBe(false);
  for (const name of ['active.jsonl', 'fresh.jsonl', 'nested/protected.jsonl']) expect(existsSync(join(path, name))).toBe(true);
  const log = readFileSync(join(path, 'retention-log.jsonl'), 'utf8');
  expect(log).not.toContain('PRIVATE');
  expect(log).not.toContain('expired.jsonl');
  sweepRoot({ path, kind: 'sessions' }, { days: 14, now, all: true, protectedPaths: [join(path, 'active.jsonl')] });
  expect(existsSync(join(path, 'fresh.jsonl'))).toBe(false);
  expect(existsSync(join(path, 'active.jsonl'))).toBe(true);
});

it('refuses links without deleting their targets or writing outside the data folder', () => {
  const path = directory(), outside = directory();
  oldFile(join(outside, 'private.jsonl'));
  symlinkSync(join(outside, 'private.jsonl'), join(path, 'linked.jsonl'));
  expect(sweepRoot({ path, kind: 'sessions' }, { days: 14, now, all: true }).reasons).toContain('retention_symlink_refused');
  symlinkSync(outside, join(path, 'linked-root'));
  expect(sweepRoot({ path: join(path, 'linked-root'), kind: 'logs' }, { days: 14, now }).reasons).toContain('retention_symlink_refused');
  expect(existsSync(join(outside, 'private.jsonl'))).toBe(true);
  expect(existsSync(join(outside, 'retention-log.jsonl'))).toBe(false);
});

it('runs cleanup at startup and hourly until closed', () => {
  vi.useFakeTimers();
  const sweep = vi.fn(), stop = startRetention(sweep);
  expect(sweep).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3600000);
  expect(sweep).toHaveBeenCalledTimes(2);
  stop();
  vi.advanceTimersByTime(3600000);
  expect(sweep).toHaveBeenCalledTimes(2);
});

it('reuses the public remote-server disclosure and optional emotional support wording', () => {
  const info = recordsInfo('computer', { RSH_RECORDS_RETENTION_DAYS: '7' }, false, true);
  const summary = recordsSummary(info);
  expect(summary).toContain('deletes it after 7 days');
  expect(summary).toContain('To judge it, Sospio sends it to the Sospio monitor server.');
  expect(summary.split('Sospio also checks whether')).toHaveLength(2);
  expect(recordsDisclosure(info)).toContain('Any copies these services keep are governed by their own terms and are not removed by deleting here.');
  expect(recordsSummary(recordsInfo('computer', { RSH_EMOTIONAL_DEPENDENCE: '0' }, false, true))).not.toContain('emotional support');
});
