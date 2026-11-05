import {
  parseSessionCreate as parseValues,
  type ProgressOutcome,
  type ProgressSessionCreate,
  type ProgressUnitRules,
} from '@rezics/progress';
import { routeOf } from '../route/route.ts';

export * from '@rezics/progress';

/** Routed reference admission belongs to Library; the shared core receives identities as values. */
export function parseSessionCreate(
  input: unknown,
  descriptor?: ProgressUnitRules | 'syntax',
): ProgressOutcome<ProgressSessionCreate> {
  const parsed = parseValues(input, descriptor);
  if (!parsed.ok) return parsed;
  if (routeOf(parsed.value.subjectId) === null) return { ok: false, field: 'subjectId' };
  if (parsed.value.versionSubjectId !== null && routeOf(parsed.value.versionSubjectId) === null)
    return { ok: false, field: 'versionSubjectId' };
  return parsed;
}
