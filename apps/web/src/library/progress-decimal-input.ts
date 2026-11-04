import { exactProgressDecimalIssue, type ProgressDecimalRules, type ProgressInputIssue } from '@rezics/progress';

export {
  progressDecimalPattern,
  progressDecimalPlaces,
  progressLocatorIssue,
  type ProgressDecimalRules,
  type ProgressInputIssue,
} from '@rezics/progress';

/** Numeric editors explicitly remove surrounding whitespace; the shared value grammar stays exact. */
export function progressDecimalIssue(
  raw: string,
  rules: ProgressDecimalRules = {},
  required = true,
): ProgressInputIssue | null {
  return exactProgressDecimalIssue(raw.trim(), rules, required);
}
