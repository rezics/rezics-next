import type { KernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import {
  candidateContext,
  candidateFailure,
  candidateHasPayload,
  readCandidateAuthority,
  selectCandidate,
  type CandidateCommand,
  type CandidateRead,
  type CandidateResult,
  type CandidateSlot,
  type ContextComparison,
} from '../../subject/candidates';
import { relationFields, relationSlotMatches, validRelationSlot } from '../../subject/relation-candidates';

const unavailableViewerActions = { state: 'unavailable', reason: 'unavailable' } as const;

export type ContextAddress = {
  id: string;
  context: string;
  property?: string;
  slot?: CandidateSlot;
  cursor?: string;
  session?: string;
};

/** The Context is explicit editorial scope. Realm dispatch never passes through this adapter. */
export async function readContextCuration(
  client: KernelClient,
  authorization: string,
  address: ContextAddress,
  release: Release | Promise<Release>,
  locale: string,
): Promise<CandidateRead> {
  try {
    const { id, context, property, slot, cursor, session } = address;
    const headers = { authorization, ...(session ? { 'rezics-session-token': session } : {}) };
    const [scope, reading, current, competition, definitions, authority] = await Promise.all([
      client.contexts({ id: context }).get({ headers }),
      client.subjects({ id }).get({ query: { context }, headers }),
      client.subjects({ id }).get(session ? { headers: { 'rezics-session-token': session } } : undefined),
      property
        ? client.subjects({ id }).candidates.get({
            query: { property, context, ...slot, limit: 20, ...(cursor ? { cursor } : {}) },
            headers,
          })
        : undefined,
      release,
      readCandidateAuthority(client, authorization, context, [id]),
    ]);
    if (!scope.data || scope.status !== 200) return candidateFailure(scope.status);
    if (!reading.data || reading.status !== 200) return candidateFailure(reading.status);
    if (!current.data || current.status !== 200) return candidateFailure(current.status);
    if (competition && (!competition.data || competition.status !== 200)) return candidateFailure(competition.status);
    if (
      scope.data.context.id !== context ||
      reading.data.subject.id !== id ||
      reading.data.subject.context !== context ||
      current.data.subject.id !== id ||
      current.data.subject.context !== candidateContext
    )
      return candidateFailure(503);
    const admitted = new Set(definitions.types[reading.data.subject.type]?.properties ?? []);
    const fields = Object.entries(definitions.properties).flatMap(([id, definition]) => {
      if (!admitted.has(id)) return [];
      if (definition.relation && definition.relation.group !== 'classification' && id !== property) return [];
      const label = pickText(definition.labels, locale).text;
      return label ? [{ id, label, multivalued: definition.multivalued === true }] : [];
    });
    const field = property ? definitions.properties[property] : undefined;
    const page = competition?.data
      ? { ...competition.data, candidates: competition.data.candidates.filter(candidateHasPayload) }
      : null;
    if (property && !fields.some((entry) => entry.id === property)) return candidateFailure(400);
    const relation = field?.relation && field.relation.group !== 'classification';
    const metadata = relationFields(definitions, reading.data.subject.type, locale).find(
      (entry) => entry.id === property,
    );
    if (relation) {
      const address = { property: property!, ...slot };
      if (
        !metadata ||
        !validRelationSlot(address) ||
        page?.candidates.some((candidate) => !relationSlotMatches(candidate.statement, address, metadata))
      )
        return candidateFailure(400);
    } else if (slot && Object.keys(slot).length) return candidateFailure(400);
    const token = competition
      ? new Headers(competition.headers).get('rezics-session-token')
      : new Headers(reading.headers).get('rezics-session-token');
    const selected = (read: typeof reading.data) =>
      (property ? (read.subject.statements[property] ?? []) : []).filter(
        (statement) =>
          (statement.rank === 'normal' || statement.rank === 'preferred') &&
          (!relation || (metadata && relationSlotMatches(statement, { property: property!, ...slot }, metadata))),
      );
    return {
      ok: true,
      public: current.data,
      page,
      fields,
      names: Object.fromEntries(
        Object.entries(definitions.properties).map(([id, definition]) => [id, definition.labels]),
      ),
      actions: {
        subject: authority.viewerActions?.subjects[id] ?? unavailableViewerActions,
        context: authority.viewerActions?.context ?? unavailableViewerActions,
      },
      contextReview: {
        context: scope.data.context,
        reading: reading.data,
        selected: selected(reading.data),
        inherited: selected(current.data),
        adoption: competition?.data?.adoption ?? null,
        ...(slot ? { slot } : {}),
      },
      ...(token ? { session: token } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

/** Interpret only native resolution. A relation diagnostic is property-wide, never a guessed slot winner. */
export function contextOutcome(
  review: ContextComparison,
  property: string,
  mode?: string,
): 'inherited' | 'replaced' | 'suppressed' | 'unresolved' {
  const resolution: unknown = review.reading.subject.resolution[property];
  if (!review.slot && resolution === 'unresolved') return 'unresolved';
  if (mode === 'suppress' || (!review.slot && resolution === 'suppressed')) return 'suppressed';
  if (mode === 'replace' || review.context.kind === 'global') return 'replaced';
  return review.context.defaults[property] === 'suppress' && mode !== 'inherit' ? 'suppressed' : 'inherited';
}

export async function confirmContextCuration(
  client: KernelClient,
  authorization: string,
  input: CandidateCommand & { context: string },
  release: Release | Promise<Release>,
  locale: string,
): Promise<CandidateResult> {
  const definitions = Promise.resolve(release).catch(() => undefined);
  // The native command checks current context:accept or context:adopt independently. No prepare grants writes.
  const result = await selectCandidate(client, authorization, input);
  if (!result.ok) return result;
  const emitted = await definitions;
  if (!emitted) return { ...result, contextRefreshFailed: true };
  const refreshed = await readContextCuration(
    client,
    authorization,
    {
      id: input.id,
      context: input.context,
      property: input.property,
      ...(input.slot ? { slot: input.slot } : {}),
      ...(result.session ? { session: result.session } : {}),
    },
    emitted,
    locale,
  );
  return {
    ...result,
    ...(refreshed.ok && refreshed.contextReview
      ? { contextReview: refreshed.contextReview, ...(refreshed.session ? { session: refreshed.session } : {}) }
      : { contextRefreshFailed: true }),
  };
}
