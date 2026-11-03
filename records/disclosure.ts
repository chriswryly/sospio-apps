export type RecordsInfo = { problem_reports?: boolean; export_enabled?: boolean; days: number; surface: 'computer' | 'server'; judges: string[]; hosted: boolean; emotional_dependence?: boolean };
const EMOTIONAL_DEPENDENCE = ' Sospio also checks whether you may be relying on the assistant for emotional support in place of people. Those readings, and the lines of your messages they quote, are kept with your other records.';

export function recordsSummary(info: RecordsInfo): string {
  return `Sospio keeps this conversation on this ${info.surface} and deletes it after ${info.days} days without use.` +
    (info.judges.length ? ` To judge it, Sospio sends it to ${info.judges.join(' and ')}.` : '') +
    (info.emotional_dependence ? EMOTIONAL_DEPENDENCE : '') +
    (info.hosted ? " Hosted assistants send it through OpenRouter to the model's host." : '');
}

export function recordsDisclosure(info: RecordsInfo): string {
  const control = info.surface === 'server' ? 'Delete my data (resets demo)' : 'Delete recorded conversations';
  return `Sospio records your conversations on this ${info.surface} to run the demo. Records are deleted automatically after ${info.days} days without a write, checked hourly while the app runs and at its next launch. Current recording files and unfinished judge work stay protected while in use; runs whose owner cannot be verified also stay protected. You can request deletion at any time with “${control}”. If work is still running, wait for it to finish and retry.` +
    (info.problem_reports ? ' If you use Report a problem, a copy of the conversation and your note is saved with your records for the Sospio team to review, and is deleted with them.' : '') +
    (info.judges.length ? ` To judge the conversation, Sospio sends it to ${info.judges.join(' and ')}.` : '') +
    (info.emotional_dependence ? EMOTIONAL_DEPENDENCE : '') +
    (info.hosted ? ' Hosted assistants send it through OpenRouter to the model’s host. Sospio only offers hosts that OpenRouter lists as keeping no copy of your messages and not training on them.' : '') +
    (info.judges.length || info.hosted ? ' Any copies these services keep are governed by their own terms and are not removed by deleting here.' : '');
}
