import { m } from '../../paraglide/messages.js';
import type { VndbRow } from './contract';

type Measure = NonNullable<NonNullable<VndbRow['decision']>['progress']>['measures'][number];

const measureStatuses = {
  applied: m.library_vndb_progress_applied,
  cleared: m.library_vndb_progress_cleared,
  preserved: m.library_vndb_progress_preserved,
  missing: m.library_vndb_progress_missing,
  unknown: m.library_vndb_progress_unknown,
  invalid: m.library_vndb_progress_invalid,
  unsupported: m.library_vndb_progress_unsupported,
  stale: m.library_vndb_progress_stale,
  failed: m.library_vndb_progress_failed,
  unattempted: m.library_vndb_progress_unattempted,
} as const satisfies Record<Measure['status'], () => string>;

export function vndbProgressAmount(amount: string | number | null | undefined, unit: string | null = 'minute'): string {
  if (amount == null) return m.library_vndb_progress_amount_unavailable();
  const value = String(amount);
  if (unit === 'minute') return m.library_vndb_progress_duration({ amount: value });
  return unit ? m.library_progress_measures_review_amount({ unit, amount: value }) : value;
}

function measureLabels(measure: Measure, amount: string | null) {
  return {
    field: measure.field === 'minutes' ? m.library_vndb_progress_title() : measure.field,
    status: measureStatuses[measure.status](),
    duration: vndbProgressAmount(amount, measure.unit),
  };
}

export function vndbProgressOutcome(measure: Measure): string {
  return m.library_vndb_progress_measure_result(measureLabels(measure, measure.currentAmount));
}

export function vndbProgressReview(measure: Measure): string {
  return m.library_vndb_progress_measure_review({
    ...measureLabels(measure, measure.sourceAmount),
    action: measure.action === 'clear' ? m.library_vndb_progress_clear() : m.library_vndb_progress_adopt(),
  });
}
