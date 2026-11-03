import { sweepRoot, retentionDays, startRetention, deletionMessage, type Root, type Options, type SweepResult } from './recordsRetention';

export class RetentionController {
  readonly days = retentionDays();
  private stop?: () => void;
  constructor(private roots: () => Root[], private options: () => Omit<Options, 'days'>) {}
  sweep(all = false): SweepResult[] {
    const results = this.roots().map(root => sweepRoot(root, { ...this.options(), days: this.days, all }));
    for (const code of new Set(results.flatMap(result => result.reasons))) {
      if (code !== 'retention_protected') process.stderr.write(code + '\n');
    }
    return results;
  }
  start(): void { this.stop = startRetention(() => { this.sweep(); }); }
  close(): void { this.stop?.(); }
  deleteAll(): string { return deletionMessage(this.sweep(true)); }
}
