import { dirname, join, resolve } from 'node:path';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';

export type SweepResult = { removed: { A: { count: number; bytes: number } }; reasons: string[] };
export type Root = { path: string; kind: 'sessions' | 'records' | 'logs' };
export type Options = { days: number; now?: number; all?: boolean; protectedPaths?: Iterable<string>; unlink?: (path: string) => void };

export function retentionDays(raw = process.env.RSH_RECORDS_RETENTION_DAYS): number {
  if (raw === undefined) return 14;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 365) throw new Error('invalid_records_retention_days');
  return Number(raw);
}

export function safePath(path: string): string {
  const absolute = resolve(path);
  for (let part = absolute; ; part = dirname(part)) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error('retention_symlink_refused');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(part) === part) break;
  }
  return absolute;
}

function directory(path: string): void {
  safePath(path);
  if (!lstatSync(path).isDirectory()) throw new Error('retention_invalid_root');
  if (realpathSync(path) !== resolve(path)) throw new Error('retention_root_mismatch');
}

function reason(result: SweepResult, code: string): void {
  if (!result.reasons.includes(code)) result.reasons.push(code);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^retention_[a-z_]+$/.test(message) ? message : 'retention_io_failed';
}

export function sweepRoot(root: Root, options: Options): SweepResult {
  retentionDays(String(options.days));
  const result: SweepResult = { removed: { A: { count: 0, bytes: 0 } }, reasons: [] };
  const protectedPaths = new Set([...options.protectedPaths ?? []].map(path => resolve(path)));
  const cutoff = (options.now ?? Date.now()) - options.days * 86400000;
  let validRoot = false;
  try {
    directory(root.path);
    validRoot = true;
    for (const name of readdirSync(root.path)) {
      if (name === 'retention-log.jsonl' || !/\.(jsonl|log)$/.test(name)) continue;
      const path = join(root.path, name);
      try {
        safePath(path);
        const stat = lstatSync(path);
        if (!stat.isFile()) continue;
        if (protectedPaths.has(resolve(path))) { reason(result, 'retention_protected'); continue; }
        if (!options.all && stat.mtimeMs >= cutoff) continue;
        try {
          (options.unlink ?? unlinkSync)(path);
          result.removed.A.count++;
          result.removed.A.bytes += stat.size;
        } catch { reason(result, 'retention_delete_failed'); }
      } catch (error) { reason(result, errorCode(error)); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(root.path)) return result;
    reason(result, errorCode(error));
  }
  if (validRoot) {
    try {
      const log = join(root.path, 'retention-log.jsonl');
      safePath(log);
      appendFileSync(log, JSON.stringify({ time: new Date(options.now ?? Date.now()).toISOString(), days: options.days, removed: result.removed, reasons: result.reasons }) + '\n', { mode: 0o600 });
    } catch { reason(result, 'retention_log_failed'); }
  }
  return result;
}

export function startRetention(sweep: () => void): () => void {
  sweep();
  const timer = setInterval(sweep, 3600000);
  timer.unref();
  return () => clearInterval(timer);
}

export function deletionMessage(results: SweepResult[]): string {
  const reasons = [...new Set(results.flatMap(result => result.reasons))].filter(code => code !== 'retention_protected');
  return reasons.length ? `Some records could not be removed: ${reasons.join(', ')}. Retry after work finishes.` : 'Recorded conversations removed.';
}

export function recordedSessionIds(dir: string, onReason: (code: string) => void = () => {}): Set<string> {
  directory(dir);
  const ids = new Set<string>();
  for (const name of readdirSync(dir).filter(name => name.endsWith('.jsonl'))) {
    const path = join(dir, name);
    safePath(path);
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); }
      catch { onReason('retention_record_line_invalid'); continue; }
      const sessionId = record?.session_id ?? record?.turn?.session_id;
      if (typeof sessionId === 'string') ids.add(sessionId);
    }
  }
  return ids;
}
