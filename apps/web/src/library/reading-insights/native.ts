import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedProblem } from '../../session/reading-policy';

export type ReadingInsightsOverview = NonNullable<Awaited<ReturnType<KernelClient['libraryReadingInsights']['get']>>['data']>;
export type InsightsRead = { kind: 'ready'; value: ReadingInsightsOverview } | { kind: 'retired' | 'denied' | 'closed' | 'unavailable' };
export type PanelValue<K extends keyof ReadingInsightsOverview['panels']> = Extract<ReadingInsightsOverview['panels'][K], { status: 'received' }>['value'];

// Match the mounted reading-insights-routes schema, using the existing Web HTTP-boundary pattern.
// The installed client exports the generated callable route, but no runtime overview schema at its root.
const count = v.pipe(v.string(), v.regex(/^[0-9]{1,19}$/));
const year = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9999));
const month = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12));
const revision = v.pipe(v.string(), v.maxLength(36));
const meaningRevision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16));
const nullableText = v.nullable(v.string());
const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
const coverage = { initializedSessions: v.nullable(count), retainedSessions: v.nullable(count) };
const snapshot = { state: v.literal('snapshot'), revision };
const currentness = <S extends string>(source: S) => v.strictObject({ ...snapshot, source: v.literal(source), retainedSourceRevision: revision });
const profile = v.strictObject({
  provenance: v.picklist(['profile', 'legacy']),
  releaseDigest: v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/)),
  profileId: text(1024), acceptingType: v.nullable(text(1024)),
});
const completionCounts = {
  completedOccurrences: count, distinctCompletedSubjects: count, repeatOccurrences: count,
  completedOccurrencesWithUnknownProfile: count,
};
const precision = v.strictObject({ year: count, month: count, day: count });
const yearCounts = { ...completionCounts, finishPrecision: precision };
const nativeCoverage = {
  nativeSessions: v.literal('complete'), otherHistory: v.literal('unavailable'), unitMeaning: v.literal('not_evaluated'),
};
const allTime = v.strictObject({
  scope: v.literal('retained_native_sessions'), ...completionCounts,
  coverage: v.strictObject(nativeCoverage), currentness: v.strictObject(snapshot),
});
const reportedYear = v.strictObject({
  scope: v.literal('retained_native_sessions'), year, calendar: v.literal('gregorian'),
  dateSource: v.literal('explicitly_reported_journal_finish'), ...yearCounts,
  months: v.pipe(v.array(v.strictObject({ month, ...yearCounts })), v.length(12)),
  monthUnallocated: v.strictObject(yearCounts),
  coverage: v.strictObject({ ...nativeCoverage, initializedSessions: count, retainedSessions: count,
    completedOccurrencesWithMissingFinish: count, completedOccurrencesWithUnsupportedFinish: count }),
  currentness: v.strictObject(snapshot),
});
const unavailable = {
  state: v.literal('unavailable'), reason: v.picklist(['not_installed', 'initializing', 'maintenance_unavailable']),
  coverage: v.strictObject(coverage),
};
const profileCounts = { completedOccurrences: count, repeatOccurrencesWithinProfile: count };
const profiles = v.union([
  v.strictObject({ scope: v.literal('selected_reported_year'), year, ...unavailable }),
  v.strictObject({
    scope: v.literal('selected_reported_year'), year, state: v.literal('available'),
    dateSource: v.literal('explicitly_reported_journal_finish'), grouping: v.literal('exact_retained_profile_pin'),
    historicalLabels: v.literal('unavailable'),
    coverage: v.strictObject({ ...coverage, nativeSessions: v.literal('complete'), otherHistory: v.literal('unavailable') }),
    currentness: currentness('reading_insights_v1'), totals: v.strictObject(profileCounts),
    profiles: v.pipe(v.array(v.strictObject({ ...profileCounts, profile })), v.maxLength(8)),
    unknown: v.strictObject(profileCounts), remainder: v.strictObject({ ...profileCounts, profileGroups: count }), limit: v.literal(8),
  }),
]);
const group = v.strictObject({
  meaning: v.strictObject({
    profilePin: profile, unitId: text(128), meaningRevision,
    mode: v.picklist(['scalar_amount', 'cursor_position', 'completed_units']), unit: text(128),
    dimension: v.nullable(v.pipe(v.string(), v.maxLength(128))),
    precision: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))),
    minimum: nullableText, maximum: nullableText,
    totalPolicy: v.nullable(v.picklist(['optional', 'required', 'forbidden'])),
    identityKind: v.picklist(['none', 'session_local']), structureKind: v.literal('none'),
    locator: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  }),
  occurrences: count, currentValue: nullableText, currentValueCount: count, missingCurrentValueCount: count,
  totalValue: nullableText, totalValueCount: count, missingTotalValueCount: count,
});
const progressScope = v.strictObject({
  sessionCount: count, coveredSessions: count, groups: v.pipe(v.array(group), v.maxLength(8)),
  remainder: v.strictObject({ groupCount: count, occurrences: count, currentValueCount: count,
    missingCurrentValueCount: count, totalValueCount: count, missingTotalValueCount: count }),
});
const currentProgress = v.union([
  v.strictObject(unavailable),
  v.strictObject({
    state: v.literal('available'), scope: v.literal('active_and_backlog_sessions'),
    coverage: v.strictObject({ initializedSessions: count, retainedSessions: count, currentSessions: count,
      activeSessions: count, backlogSessions: count, coveredSessions: count, unsupportedSessions: count }),
    currentness: currentness('reading_insights_current_progress_v1'), active: progressScope, backlog: progressScope, limit: v.literal(8),
  }),
]);
const assessments = v.union([
  v.strictObject({ scope: v.literal('retained_nonretired_sessions'), ...unavailable }),
  v.strictObject({
    scope: v.literal('retained_nonretired_sessions'), state: v.literal('available'),
    coverage: v.strictObject({ ...coverage, includedSessions: count }),
    currentness: currentness('reading_insights_assessments_v1'),
    revisions: v.pipe(v.array(v.strictObject({ meaningRevision,
      counts: v.strictObject({ absent: count, explicitNull: count, value: count, historicalUnknown: count }),
      values: v.pipe(v.array(v.strictObject({ units: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20)), occurrences: count })), v.maxLength(21)),
    })), v.maxLength(16)),
  }),
]);
const failed = v.strictObject({ status: v.literal('failed'), reason: v.picklist([
  'semantic_not_ready', 'dependency_unavailable', 'overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded',
]) });
const panel = <S extends v.GenericSchema>(schema: S) => v.union([v.strictObject({ status: v.literal('received'), value: schema }), failed]);
const action = { operationId: v.literal('library_diary.list') };
const overview = v.strictObject({
  scope: v.literal('private_reading_insights'), year,
  panels: v.strictObject({ allTime: panel(allTime), reportedYear: panel(reportedYear), profiles: panel(profiles),
    currentProgress: panel(currentProgress), assessments: panel(assessments) }),
  actions: v.strictObject({
    diary: v.strictObject({ ...action, query: v.strictObject({ year }) }),
    months: v.pipe(v.array(v.strictObject({ ...action, month, query: v.strictObject({ year, month }) })), v.length(12)),
    unallocatedMonth: v.strictObject({ ...action, query: v.strictObject({ year, month: v.literal('unallocated') }) }),
  }),
}) satisfies v.GenericSchema<ReadingInsightsOverview>;

/** A wrong-year response or duplicate month cannot redirect a selected-year diary action. */
export function receiveInsights(value: unknown, selectedYear: number): InsightsRead {
  const parsed = v.safeParse(overview, value);
  if (!parsed.success) return { kind: 'unavailable' };
  const data = parsed.output;
  const actions = data.actions;
  if (data.year !== selectedYear || actions.diary.query.year !== selectedYear || actions.unallocatedMonth.query.year !== selectedYear ||
    new Set(actions.months.map((entry) => entry.month)).size !== 12 ||
    actions.months.some((entry) => entry.query.year !== selectedYear || entry.month !== entry.query.month) ||
    (data.panels.reportedYear.status === 'received' && (data.panels.reportedYear.value.year !== selectedYear ||
      new Set(data.panels.reportedYear.value.months.map((entry) => entry.month)).size !== 12)) ||
    (data.panels.profiles.status === 'received' && data.panels.profiles.value.year !== selectedYear)) return { kind: 'unavailable' };
  return { kind: 'ready', value: data };
}

export async function readInsights(client: KernelClient, authorization: string, selectedYear: number): Promise<InsightsRead> {
  const result = await client.libraryReadingInsights.get({ query: { year: selectedYear }, headers: { authorization }, fetch: { cache: 'no-store' } });
  if (!result.error && result.status === 200) return receiveInsights(result.data, selectedYear);
  if (result.status === 401) return { kind: 'retired' };
  if (isPlatformClosedProblem(result.status, result.error?.value)) return { kind: 'closed' };
  return { kind: result.status === 403 ? 'denied' : 'unavailable' };
}
