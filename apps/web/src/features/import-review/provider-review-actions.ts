import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Candidate } from '../../subject/candidates';

export const providerSelectionLimit = 20;
export type ProviderScope = { source: string; context: string; status: string };
/** A prepared, currently visible row supplied by the queue; never an authorization grant. */
export type ProviderDecisionRow = {
  subject: string;
  candidate: Candidate;
  label: string;
  href: string;
  propertyLabel: string;
  related: SubjectRead['related'];
  /** Confirmed native page operations; mounted queues always provide this field. */
  operations?: readonly string[];
  /** Only this page's exact authenticated Context read; absence is not an empty selection. */
  reading?: ProviderReading['result'];
};
export type ProviderDecision = {
  subject: string;
  candidate: string;
  context: string;
  head: number | null;
  operation: 'accept' | 'reject';
  key: string;
  session?: string;
};
export type ProviderFailure = {
  ok: false;
  reason: 'stale' | 'denied' | 'missing' | 'rate-limited' | 'unavailable' | 'invalid' | 'key-conflict';
  retryAfter?: string;
};
export type ProviderDecisionResult = ProviderFailure | { ok: true; kind: 'accepted' | 'rejected'; session?: string };
export type ProviderAttempt = { row: ProviderDecisionRow; command: ProviderDecision; result?: ProviderDecisionResult };
export type ProviderBatch = { scope: ProviderScope; attempts: ProviderAttempt[] };
export type ProviderReading = { subject: string; result: ProviderFailure | { ok: true; current: SubjectRead } };

export async function readProviderDecisionSubjects(
  client: KernelClient,
  authorization: string,
  commands: readonly Pick<ProviderDecision, 'subject' | 'context' | 'session'>[],
): Promise<ProviderReading[]> {
  const unique = new Map(commands.map((command) => [JSON.stringify([command.subject, command.context]), command]));
  return Promise.all(
    [...unique.values()].map(async (command): Promise<ProviderReading> => {
      try {
        const result = await client.subjects({ id: command.subject }).get({
          query: { context: command.context },
          headers: { authorization, ...(command.session ? { 'rezics-session-token': command.session } : {}) },
        });
        return {
          subject: command.subject,
          result:
            result.status === 200 &&
            result.data?.subject.id === command.subject &&
            result.data.subject.context === command.context
              ? { ok: true, current: result.data }
              : providerFailure(result.status === 200 ? 503 : result.status),
        };
      } catch {
        return { subject: command.subject, result: providerFailure(503) };
      }
    }),
  );
}

export function providerScopeKey(scope: ProviderScope): string {
  return JSON.stringify([scope.source, scope.context, scope.status]);
}
export function providerRowKey(row: ProviderDecisionRow): string {
  return JSON.stringify([row.subject, row.candidate.id]);
}

export function providerSelectionInScope(selection: { scope: string; ids: string[] }, scope: string): string[] {
  return selection.scope === scope ? selection.ids : [];
}

export function providerRowIsSelectable(row: ProviderDecisionRow, scope: ProviderScope): boolean {
  const source = row.candidate.source;
  return (
    row.reading?.ok === true &&
    !providerRowIsConcealed(row) &&
    row.candidate.retracted === null &&
    !!source &&
    'source' in source &&
    source.source === scope.source
  );
}

export function providerRowAllows(row: ProviderDecisionRow, operation: ProviderDecision['operation']): boolean {
  return (
    row.operations?.includes(`subject.${operation}_candidate`) === true &&
    (operation === 'accept' ? row.candidate.decision !== 'accepted' : row.candidate.decision !== 'rejected')
  );
}

export function providerRowIsConcealed(row: ProviderDecisionRow): boolean {
  return !!row.reading && !row.reading.ok && (row.reading.reason === 'denied' || row.reading.reason === 'missing');
}

/** Seal only explicit checkboxes on this visible page, including each independent decision head. */
export function prepareProviderBatch(
  scope: ProviderScope,
  visible: readonly ProviderDecisionRow[],
  selected: readonly string[],
  operation: ProviderDecision['operation'],
  key: () => string = () => crypto.randomUUID(),
  session?: string,
): ProviderBatch | null {
  const wanted = new Set(selected);
  if (!wanted.size || wanted.size > providerSelectionLimit) return null;
  const rows = new Map(visible.map((row) => [providerRowKey(row), row]));
  const chosen = [...wanted].map((id) => rows.get(id));
  if (chosen.some((row) => !row || !providerRowIsSelectable(row, scope) || !providerRowAllows(row, operation)))
    return null;
  return {
    scope: { ...scope },
    attempts: chosen.map((row) => ({
      row: structuredClone(row!),
      command: {
        subject: row!.subject,
        candidate: row!.candidate.id,
        context: scope.context,
        head: row!.candidate.head,
        operation,
        key: key(),
        ...(session ? { session } : {}),
      },
    })),
  };
}

/** Event-owned bounded work. Retry keeps every failed payload and key, and skips confirmed successes. */
export async function runProviderBatch(
  batch: ProviderBatch,
  confirm: (command: ProviderDecision) => Promise<ProviderDecisionResult>,
): Promise<ProviderBatch> {
  const attempts = await Promise.all(
    batch.attempts.map(async (attempt): Promise<ProviderAttempt> => {
      if (attempt.result?.ok) return attempt;
      try {
        return { ...attempt, result: await confirm(structuredClone(attempt.command)) };
      } catch {
        return { ...attempt, result: { ok: false, reason: 'unavailable' } };
      }
    }),
  );
  return { ...batch, attempts };
}

export function providerFailure(status: number, headers?: HeadersInit): ProviderFailure {
  const retryAfter = new Headers(headers).get('retry-after');
  return {
    ok: false,
    reason:
      status === 401 || status === 403
        ? 'denied'
        : status === 404
          ? 'missing'
          : status === 409
            ? 'stale'
            : status === 429
              ? 'rate-limited'
              : status === 422
                ? 'key-conflict'
                : status === 400
                  ? 'invalid'
                  : 'unavailable',
    ...(status === 429 && retryAfter ? { retryAfter } : {}),
  };
}

/** Use the generated per-candidate native decision, in the actual Context, with the current BFF caller. */
export async function decideProviderCandidate(
  client: KernelClient,
  authorization: string,
  command: ProviderDecision,
): Promise<ProviderDecisionResult> {
  try {
    const endpoint = client.subjects({ id: command.subject }).candidates({ candidate: command.candidate });
    const body = { context: command.context, expected_head: command.head };
    const options = {
      headers: {
        authorization,
        'idempotency-key': command.key,
        ...(command.session ? { 'rezics-session-token': command.session } : {}),
      },
    };
    const result =
      command.operation === 'accept'
        ? await endpoint.$accept.post(body, options)
        : await endpoint.$reject.post(body, options);
    if (result.status !== 200 || !result.data) return providerFailure(result.status, result.headers);
    const { acceptance } = result.data;
    if (
      acceptance.context !== command.context ||
      acceptance.candidate !== command.candidate ||
      !Number.isSafeInteger(acceptance.head) ||
      acceptance.head < 1 ||
      acceptance.decision !== command.operation
    )
      return providerFailure(503);
    const session = new Headers(result.headers).get('rezics-session-token');
    return {
      ok: true,
      kind: command.operation === 'accept' ? 'accepted' : 'rejected',
      ...(session ? { session } : {}),
    };
  } catch {
    return providerFailure(503);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function providerDecisionInput(value: unknown): ProviderDecision {
  if (!value || typeof value !== 'object') throw new Error('Invalid provider decision');
  const v = value as Record<string, unknown>;
  if (
    !['subject', 'candidate', 'context', 'key'].every((field) => typeof v[field] === 'string' && uuid.test(v[field])) ||
    (v.operation !== 'accept' && v.operation !== 'reject') ||
    (v.head !== null && (!Number.isSafeInteger(v.head) || Number(v.head) < 1)) ||
    (v.session !== undefined && (typeof v.session !== 'string' || v.session.length > 16384))
  )
    throw new Error('Invalid provider decision');
  return {
    subject: v.subject as string,
    candidate: v.candidate as string,
    context: v.context as string,
    key: v.key as string,
    head: v.head as number | null,
    operation: v.operation,
    ...(typeof v.session === 'string' ? { session: v.session } : {}),
  };
}
