import { retentionDays } from './recordsRetention';
import type { RecordsInfo } from './disclosure';

export function emotionalDependenceMonitored(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RSH_EMOTIONAL_DEPENDENCE?.trim() !== '0';
}

export function recordsInfo(surface: RecordsInfo['surface'], env: NodeJS.ProcessEnv = process.env, _unusedLocal = false, emotionalDependence = false): RecordsInfo {
  return {
    problem_reports: false,
    export_enabled: surface === 'computer',
    days: retentionDays(env.RSH_RECORDS_RETENTION_DAYS),
    surface,
    judges: ['the Sospio monitor server'],
    hosted: env.RSH_LOCAL_HOSTED_ASSISTANT === '1',
    ...(emotionalDependence && emotionalDependenceMonitored(env) ? { emotional_dependence: true } : {}),
  };
}
