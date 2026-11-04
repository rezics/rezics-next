import type { KernelClient, SubjectRead } from '@rezics/client';

type Endpoint = ReturnType<KernelClient['subjects']>;
type NativeCandidatePage = NonNullable<Awaited<ReturnType<Endpoint['candidates']['get']>>['data']>;
export type Candidate = Exclude<NativeCandidatePage['candidates'][number], { deleted: true }>;
export type CandidatePage = Omit<NativeCandidatePage, 'candidates'> & { candidates: Candidate[] };

/** Deleted references carry no comparison, disclosure or adoption payload. */
export function candidateHasPayload(candidate: NativeCandidatePage['candidates'][number]): candidate is Candidate {
  return !('deleted' in candidate && candidate.deleted === true);
}
export type CandidateField = { id: string; label: string; multivalued?: boolean };
export type CandidateSlot = { target?: string; sameAs?: string; key?: string };
export type CandidateSelection = { candidate: string; rank: 'normal' | 'preferred' };
export type ReviewContext = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['contexts']>['get']>>['data']
>['context'];
export type ContextComparison = {
  context: ReviewContext;
  reading: SubjectRead;
  slot?: CandidateSlot;
  selected: SubjectRead['subject']['statements'][string];
  inherited: SubjectRead['subject']['statements'][string];
  adoption: CandidatePage['adoption'];
};
export type CandidateFailure = {
  ok: false;
  reason: 'denied' | 'stale' | 'unavailable' | 'invalid';
  clearPrivate?: boolean;
};
export type ViewerActionEntry = { action: string; operations: string[] };
export type ViewerActionComponent =
  | { state: 'not-requested' }
  | { state: 'unavailable'; reason: 'not-found' | 'unavailable' }
  | { state: 'available'; actions: ViewerActionEntry[] };
export type CandidateViewerActions = { subject: ViewerActionComponent; context: ViewerActionComponent };
export type NativeOperationAvailability = 'allowed' | 'denied' | 'unavailable';

export function nativeOperationAvailability(
  component: ViewerActionComponent | undefined,
  action: string,
  operation: string,
): NativeOperationAvailability {
  if (!component || component.state !== 'available') return 'unavailable';
  return component.actions.some((entry) => entry.action === action && entry.operations.includes(operation))
    ? 'allowed'
    : 'denied';
}

export type CandidateRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      fields: CandidateField[];
      names: Record<string, Record<string, string>>;
      page: CandidatePage | null;
      /** Current native operation projection when supplied by this page's bounded reader. */
      actions?: CandidateViewerActions;
      contextReview?: ContextComparison;
      session?: string;
    };
export type CandidateCommand = {
  /** Browser mismatch guard, excluded from native payloads and receipts. */
  expectedReader?: string;
  id: string;
  property: string;
  candidate: string;
  operation: 'accept' | 'reject' | 'adopt';
  head: number | null;
  key: string;
  slot?: CandidateSlot;
  rank?: 'normal' | 'preferred';
  /** Explicit whole-slot replacement; omitted only by existing single-candidate callers. */
  selection?: CandidateSelection[];
  session?: string;
  context?: string;
  mode?: 'inherit' | 'replace' | 'suppress';
};
export type CandidateResult =
  | CandidateFailure
  | {
      ok: true;
      kind: 'accepted' | 'rejected' | 'selected' | 'pending';
      public: SubjectRead | null;
      session?: string;
      contextReview?: ContextComparison;
      contextRefreshFailed?: boolean;
    };

export const candidateContext = '00000000-0000-8000-8000-000000000000';

export type CandidateActions = { state: 'available'; context: string; operations: string[] } | { state: 'unavailable' };
export type CandidateAuthority = {
  actions: CandidateActions;
  disclosure: 'available' | 'unreadable' | 'unavailable';
  viewerActions?: { context: ViewerActionComponent; subjects: Record<string, ViewerActionComponent> };
};

const unavailableViewerActions = (reason: 'not-found' | 'unavailable' = 'unavailable'): ViewerActionComponent => ({
  state: 'unavailable',
  reason,
});

/** One native projection for mounted candidate operations and at most three exact Subject references. */
export async function readCandidateAuthority(
  client: KernelClient,
  authorization: string,
  context: string,
  subjects: readonly string[] = [],
): Promise<CandidateAuthority> {
  const subjectIds = subjects.length <= 3 ? [...new Set(subjects)] : [];
  const unavailable: CandidateAuthority = {
    actions: { state: 'unavailable' },
    disclosure: 'unavailable',
    viewerActions: {
      context: unavailableViewerActions(),
      subjects: Object.fromEntries(subjectIds.map((id) => [id, unavailableViewerActions()])),
    },
  };
  if (subjects.length > 3) return unavailable;
  const references = [
    { type: 'semantic.context', id: context },
    ...subjectIds.map((id) => ({ type: 'semantic.subject', id })),
  ];
  try {
    const result = await client.viewerActions.post(
      { resources: references },
      { headers: { authorization }, fetch: { cache: 'no-store' } },
    );
    if (result.status !== 200 || !result.data || result.data.resources.length !== references.length) return unavailable;
    const component = (type: string, id: string): ViewerActionComponent => {
      const matches = result.data!.resources.filter((resource) => resource.type === type && resource.id === id);
      if (matches.length !== 1) return unavailableViewerActions();
      const resource = matches[0]!;
      if (!('viewerActions' in resource)) return unavailableViewerActions('not-found');
      const entries = resource.viewerActions;
      if (
        entries.length > 64 ||
        entries.reduce((count, entry) => count + entry.operations.length, 0) > 256 ||
        entries.some(
          (entry) =>
            typeof entry.action !== 'string' ||
            !Array.isArray(entry.operations) ||
            entry.operations.some((operation) => typeof operation !== 'string'),
        )
      )
        return unavailableViewerActions();
      return {
        state: 'available',
        actions: entries.map((entry) => ({ action: entry.action, operations: [...entry.operations] })),
      };
    };
    const bindings: Record<string, string> = {
      'subject.propose': 'statement:propose',
      'subject.accept_candidate': 'context:accept',
      'subject.reject_candidate': 'context:accept',
      'subject.adopt': 'context:adopt',
    };
    const nativeContextActions = component('semantic.context', context);
    const contextActions: ViewerActionComponent =
      nativeContextActions.state === 'available'
        ? {
            state: 'available',
            actions: nativeContextActions.actions.flatMap((entry) => {
              const operations = entry.operations.filter((operation) => bindings[operation] === entry.action);
              return operations.length ? [{ action: entry.action, operations }] : [];
            }),
          }
        : nativeContextActions;
    const subjectActions: Record<string, ViewerActionComponent> = Object.fromEntries(
      subjectIds.map((id) => {
        const native = component('semantic.subject', id);
        if (native.state !== 'available') return [id, native];
        return [
          id,
          {
            state: 'available' as const,
            actions: native.actions.flatMap((entry) => {
              const operations =
                entry.action === 'subject:read'
                  ? entry.operations.filter((operation) => operation === 'subject.list_candidates')
                  : [];
              return operations.length ? [{ action: entry.action, operations }] : [];
            }),
          },
        ];
      }),
    );
    const viewerActions = { context: contextActions, subjects: subjectActions };
    if (contextActions.state !== 'available') return { ...unavailable, viewerActions };
    const unreadable = Object.values(subjectActions).some(
      (actions) => actions.state === 'unavailable' && actions.reason === 'not-found',
    );
    const subjectUnavailable = Object.values(subjectActions).some(
      (actions) => actions.state === 'unavailable' && actions.reason !== 'not-found',
    );
    return {
      actions: {
        state: 'available',
        context,
        operations: [...new Set(contextActions.actions.flatMap((entry) => entry.operations))],
      },
      disclosure: unreadable ? 'unreadable' : subjectUnavailable ? 'unavailable' : 'available',
      viewerActions,
    };
  } catch {
    return unavailable;
  }
}

export function candidateViewerActionsFor(authority: CandidateAuthority, subject: string): CandidateViewerActions {
  return {
    context: authority.viewerActions?.context ?? unavailableViewerActions(),
    subject: authority.viewerActions?.subjects[subject] ?? { state: 'not-requested' },
  };
}

/** Optional producer metadata follows the existing subject Sources region's runtime compatibility read. */
export function candidateSourceRecords(subject: object): {
  name: string;
  url: string;
  attribution?: string;
  licence?: { id: string; url?: string };
}[] {
  const records: unknown = Reflect.get(subject, 'sourceRecords');
  if (!Array.isArray(records)) return [];
  return records.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.url !== 'string') return [];
    const licence = record.licence as { id?: unknown; url?: unknown } | null | undefined;
    return [
      {
        name: record.name,
        url: record.url,
        ...(typeof record.attribution === 'string' ? { attribution: record.attribution } : {}),
        ...(licence && typeof licence.id === 'string'
          ? { licence: { id: licence.id, ...(typeof licence.url === 'string' ? { url: licence.url } : {}) } }
          : {}),
      },
    ];
  });
}

export function candidateFailure(status: number): CandidateFailure {
  // Missing and hidden use the same unavailable outcome. Never reveal existence from a denial.
  return {
    ok: false,
    reason:
      status === 401 || status === 403
        ? 'denied'
        : status === 409
          ? 'stale'
          : status === 400 || status === 422
            ? 'invalid'
            : 'unavailable',
  };
}

export async function readCandidates(
  client: KernelClient,
  authorization: string,
  id: string,
  property?: string,
  cursor?: string,
  slot?: CandidateSlot,
  session?: string,
  context = candidateContext,
): Promise<CandidateRead> {
  try {
    // Public reading and private competition are independent. Neither uses per-value hydration.
    // Ordinary public GET carries Session continuity only; viewer authorization stays on competition.
    const publicHeaders = session ? { headers: { 'rezics-session-token': session } } : undefined;
    const [current, result] = await Promise.all([
      client.subjects({ id }).get({ query: { context }, ...(publicHeaders ?? {}) }),
      property
        ? client.subjects({ id }).candidates.get({
            query: { property, context, ...slot, limit: 20, ...(cursor ? { cursor } : {}) },
            headers: { authorization, ...(session ? { 'rezics-session-token': session } : {}) },
          })
        : undefined,
    ]);
    if (!current.data || current.status !== 200) return candidateFailure(current.status);
    if (current.data.subject.id !== id || current.data.subject.context !== context)
      return candidateFailure(400);
    if (result && (!result.data || result.status !== 200)) return candidateFailure(result.status);
    const token = result ? new Headers(result.headers).get('rezics-session-token') : null;
    return {
      ok: true,
      public: current.data,
      fields: [],
      names: {},
      // Native deleted tombstones carry no candidate payload and cannot enter comparison/adoption drafts.
      page: result?.data
        ? {
            ...result.data,
            candidates: result.data.candidates.filter(candidateHasPayload),
          }
        : null,
      ...(token ? { session: token } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

export function candidateIsPublic(
  current: SubjectRead,
  property: string,
  candidate: string,
  slot?: CandidateSlot,
): boolean {
  return publicCandidateSelection(current, property, slot).some((entry) => entry.candidate === candidate);
}

/** Disclosed selected statements for one exact slot from the ordinary public reader. */
export function publicSlotStatements(
  current: SubjectRead,
  property: string,
  slot?: CandidateSlot,
): SubjectRead['subject']['statements'][string] {
  return (current.subject.statements[property] ?? []).filter((statement) => {
    if (statement.rank !== 'normal' && statement.rank !== 'preferred') return false;
    if (slot?.target && (statement.value.type !== 'value' || statement.value.content !== slot.target)) return false;
    if (
      slot?.sameAs &&
      (statement.value.type !== 'somevalue' ||
        !statement.qualifiers.some(
          (snak) =>
            snak.property.id === 'schema:sameAs' && snak.value.type === 'value' && snak.value.content === slot.sameAs,
        ))
    )
      return false;
    if (
      slot?.key &&
      !statement.qualifiers.some((snak) => snak.value.type === 'value' && snak.value.content === slot.key)
    )
      return false;
    return true;
  });
}

/** Only disclosed, admitted selected ranks from the ordinary reader establish public selection. */
export function publicCandidateSelection(
  current: SubjectRead,
  property: string,
  slot?: CandidateSlot,
): CandidateSelection[] {
  return publicSlotStatements(current, property, slot).map((statement) => ({
    candidate: statement.id,
    rank: statement.rank as CandidateSelection['rank'],
  }));
}

export function sameCandidateSelection(left: CandidateSelection[], right: CandidateSelection[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry) => right.some((other) => entry.candidate === other.candidate && entry.rank === other.rank))
  );
}

function acknowledgedCommand(
  value: unknown,
  input: CandidateCommand,
  context: string,
  mode: NonNullable<CandidateCommand['mode']>,
  selection: CandidateSelection[],
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) return false;
  if (input.operation !== 'adopt') {
    const acceptance = record.acceptance;
    if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) return false;
    const decision = acceptance as Record<string, unknown>;
    return (
      decision.context === context &&
      decision.candidate === input.candidate &&
      decision.decision === input.operation &&
      Number.isSafeInteger(decision.head) &&
      (decision.head as number) >= 0
    );
  }
  const adoption = record.adoption;
  if (!adoption || typeof adoption !== 'object' || Array.isArray(adoption)) return false;
  const result = adoption as Record<string, unknown>;
  if (
    result.context !== context ||
    result.property !== input.property ||
    result.mode !== mode ||
    !Number.isSafeInteger(result.head) ||
    (result.head as number) < 0 ||
    !Array.isArray(result.selection) ||
    result.selection.length !== selection.length
  )
    return false;
  const remaining = new Map(selection.map((entry) => [entry.candidate, entry.rank]));
  for (const entry of result.selection) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const acknowledged = entry as Record<string, unknown>;
    if (
      typeof acknowledged.candidate !== 'string' ||
      (acknowledged.rank !== 'normal' && acknowledged.rank !== 'preferred') ||
      remaining.get(acknowledged.candidate) !== acknowledged.rank
    )
      return false;
    remaining.delete(acknowledged.candidate);
  }
  return remaining.size === 0;
}

/** One confirmed native command, followed by one ordinary public read; never substitute proposal JSON. */
export async function selectCandidate(
  client: KernelClient,
  authorization: string,
  input: CandidateCommand,
): Promise<CandidateResult> {
  try {
    const endpoint = client.subjects({ id: input.id });
    const context = input.context ?? candidateContext;
    const mode = input.mode ?? 'replace';
    const selection = input.selection ?? [{ candidate: input.candidate, rank: input.rank ?? 'normal' }];
    if (
      input.operation === 'adopt' &&
      ((context === candidateContext && mode !== 'replace') ||
        (mode !== 'replace' && selection.length !== 0) ||
        selection.length > 32 ||
        new Set(selection.map((entry) => entry.candidate)).size !== selection.length ||
        selection.some((entry) => entry.rank !== 'normal' && entry.rank !== 'preferred'))
    )
      return candidateFailure(400);
    const options = {
      headers: {
        authorization,
        'idempotency-key': input.key,
        ...(input.session ? { 'rezics-session-token': input.session } : {}),
      } as { 'idempotency-key': string },
    };
    const decision = { context, expected_head: input.head };
    const result =
      input.operation === 'accept'
        ? await endpoint.candidates({ candidate: input.candidate }).$accept.post(decision, options)
        : input.operation === 'reject'
          ? await endpoint.candidates({ candidate: input.candidate }).$reject.post(decision, options)
          : await endpoint.$adopt.post(
              {
                context,
                property: input.property,
                ...input.slot,
                mode,
                selection,
                expected_head: input.head,
              },
              options,
            );
    if (result.status !== 200 || !result.data) return candidateFailure(result.status);
    if (!acknowledgedCommand(result.data, input, context, mode, selection)) return candidateFailure(503);
    const session = new Headers(result.headers).get('rezics-session-token') ?? input.session;
    let current: SubjectRead | null = null;
    try {
      const read = await endpoint.get({
        query: { context },
        ...(session ? { headers: { 'rezics-session-token': session } } : {}),
      });
      if (read.status === 200 && read.data?.subject.id === input.id && read.data.subject.context === context)
        current = read.data;
    } catch {
      /* A committed command does not prove that the public reader is ready. */
    }
    return {
      ok: true,
      kind:
        input.operation === 'reject'
          ? 'rejected'
          : input.operation === 'accept'
            ? context === candidateContext &&
              current &&
              candidateIsPublic(current, input.property, input.candidate, input.slot)
              ? 'selected'
              : 'accepted'
            : context === candidateContext &&
                current &&
                sameCandidateSelection(publicCandidateSelection(current, input.property, input.slot), selection)
              ? 'selected'
              : 'pending',
      public: current,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
