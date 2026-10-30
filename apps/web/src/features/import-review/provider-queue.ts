import {
  providerFailure,
  decideProviderCandidate as decideNativeProviderCandidate,
  type ProviderDecisionRow,
  type ProviderFailure,
  type ProviderScope,
  type ProviderDecision,
  type ProviderReading,
} from './provider-review-actions';
import type { KernelClient } from '@rezics/client';
import type { Release } from '../../subject/definitions';
import { candidateFailure } from '../../subject/candidates';

/** Presentation props retained for the existing bounded decision-action component. */
export type ProviderQueueRow = ProviderDecisionRow;
export type ProviderQueuePage = {
  scope: ProviderScope;
  sourceLabel: string;
  contextLabel: string;
  statusLabel: string;
  rows: ProviderQueueRow[];
  session?: string;
};
export type ProviderQueueRead = ProviderFailure | { ok: true; page: ProviderQueuePage };

export const globalReviewContext = '00000000-0000-8000-8000-000000000000';
export type QueueScope = { source: string; context: string; status: 'pending' | 'accepted_unselected' };
type QueueResponse = NonNullable<Awaited<ReturnType<KernelClient['review-candidates']['get']>>['data']>;
export type QueuePage = Extract<QueueResponse, { candidates: unknown }>;
export type QueueRow = QueuePage['candidates'][number];
export type QueueState =
  | { state: 'idle' | 'loading' | 'denied' | 'missing' | 'invalid' | 'unavailable' }
  | { state: 'preparing'; next?: string }
  | { state: 'ready'; page: QueuePage; names: Record<string, Record<string, string>>; session?: string };
export type QueueDecision = QueueScope & {
  subject: string;
  candidate: string;
  operation: 'accept' | 'reject';
  head: number | null;
  key: string;
  session?: string;
};
export type QueueDecisionResult = ProviderFailure | { ok: true; session?: string };
export type QueueTransport = {
  read(scope: QueueScope, cursor?: string, session?: string): Promise<QueueState>;
  prepare(scope: QueueScope): Promise<QueueState>;
  decide(command: QueueDecision): Promise<QueueDecisionResult>;
  readings(commands: ProviderDecision[]): Promise<ProviderReading[]>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validQueueScope(value: unknown): value is QueueScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as QueueScope;
  return (
    Object.keys(scope).every((key) => ['source', 'context', 'status'].includes(key)) &&
    typeof scope.source === 'string' &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(scope.source) &&
    typeof scope.context === 'string' &&
    uuid.test(scope.context) &&
    (scope.status === 'pending' || scope.status === 'accepted_unselected')
  );
}
export function validQueueDecision(value: unknown): value is QueueDecision {
  if (!value || typeof value !== 'object') return false;
  const input = value as QueueDecision;
  return (
    Object.keys(input).every((key) =>
      ['source', 'context', 'status', 'subject', 'candidate', 'operation', 'head', 'key', 'session'].includes(key),
    ) &&
    validQueueScope({ source: input.source, context: input.context, status: input.status }) &&
    typeof input.subject === 'string' &&
    uuid.test(input.subject) &&
    typeof input.candidate === 'string' &&
    uuid.test(input.candidate) &&
    (input.operation === 'accept' || input.operation === 'reject') &&
    (input.head === null || (Number.isInteger(input.head) && input.head! >= 1)) &&
    typeof input.key === 'string' &&
    uuid.test(input.key) &&
    (input.session === undefined || (typeof input.session === 'string' && input.session.length <= 16384))
  );
}
const stateFor = (status: number): QueueState => {
  if (status === 404) return { state: 'missing' };
  const reason = candidateFailure(status).reason;
  return { state: reason === 'stale' ? 'invalid' : reason };
};

/** One native queue request; labels are an independent definitions read, never per-row hydration. */
export function readProviderQueue(): Promise<ProviderQueueRead>;
export function readProviderQueue(
  client: KernelClient,
  authorization: string,
  definitions: Promise<Release>,
  scope: QueueScope,
  cursor?: string,
  session?: string,
): Promise<QueueState>;
export async function readProviderQueue(
  client?: KernelClient,
  authorization?: string,
  definitions?: Promise<Release>,
  scope?: QueueScope,
  cursor?: string,
  session?: string,
): Promise<QueueState | ProviderQueueRead> {
  // An unscoped presentation caller cannot turn the provider API into a catalogue scan.
  if (!client || !authorization || !definitions || !scope) return { ok: false, reason: 'unavailable' };
  try {
    const [result, release, contextDefinitions] = await Promise.all([
      client['review-candidates'].get({
        query: { ...scope, limit: 20, ...(cursor ? { cursor } : {}) },
        headers: { authorization, ...(session ? { 'rezics-session-token': session } : {}) },
      }),
      definitions,
      client.contexts({ id: scope.context }).definitions.get({ headers: { authorization } }),
    ]);
    if (result.status === 202 && result.data && 'next' in result.data && !('candidates' in result.data))
      return { state: 'preparing', next: result.data.next };
    if (result.status !== 200 || !result.data || !('candidates' in result.data)) return stateFor(result.status);
    const token = new Headers(result.headers).get('rezics-session-token');
    const names = Object.fromEntries(
      Object.entries(release.properties).map(([id, definition]) => [id, definition.labels ?? {}]),
    );
    const terms: unknown = contextDefinitions.data?.extension?.terms;
    if (terms && typeof terms === 'object' && !Array.isArray(terms)) {
      for (const [id, term] of Object.entries(terms)) {
        if (!term || typeof term !== 'object' || !('labels' in term)) continue;
        const labels: unknown = term.labels;
        if (labels && typeof labels === 'object' && !Array.isArray(labels))
          names[id] = Object.fromEntries(
            Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          );
      }
    }
    return {
      state: 'ready',
      page: result.data,
      names,
      ...(token ? { session: token } : {}),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
export async function prepareProviderQueue(
  client: KernelClient,
  authorization: string,
  scope: QueueScope,
): Promise<QueueState> {
  try {
    const result = await client['review-candidates'].$prepare.post(scope, { headers: { authorization } });
    return result.status === 202 ? { state: 'preparing' } : stateFor(result.status);
  } catch {
    return { state: 'unavailable' };
  }
}
/** Preparation/read authority never becomes selection authority. Native decisions retain the exact Context/head. */
export async function decideProviderCandidate(
  client: KernelClient,
  authorization: string,
  input: QueueDecision,
): Promise<QueueDecisionResult> {
  const result = await decideNativeProviderCandidate(client, authorization, {
    subject: input.subject,
    candidate: input.candidate,
    context: input.context,
    head: input.head,
    operation: input.operation,
    // The private draft retains its UUID; only the native structured header is quoted.
    key: JSON.stringify(input.key),
    ...(input.session ? { session: input.session } : {}),
  });
  if (!result.ok) return result;
  const session = result.session ?? input.session;
  return { ok: true, ...(session ? { session } : {}) };
}
