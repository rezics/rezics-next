import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { candidateSources, fencedIds, sourceTuple, type CandidateSource } from './fences.ts';
import readLiveCandidates from './current-relations-live-candidate.sql';
import readCompactRelationCandidates from './current-relations-compact.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { hiddenCandidateKeys, slotView } from './slots.ts';
import type { FactRow } from './item.ts';
import { redirectOf } from './merges.ts';

export type CurrentRelationCandidate = {
  subject: string;
  property: string;
  candidate: string;
  target: string | null;
  external?: string | null;
  value?: 'value' | 'somevalue' | 'novalue';
  context?: string;
  defaults?: Readonly<Record<string, 'inherit' | 'suppress'>>;
  slot?: string;
  filter?: string;
  filterProperties?: readonly string[];
  requireRelation?: boolean;
};

export function currentRelationKey(candidate: Pick<CurrentRelationCandidate, 'subject' | 'property' | 'candidate'>) {
  return `${candidate.subject}\n${candidate.property}\n${candidate.candidate}`;
}

function externalValue(fact: FactRow): string | null {
  const body = fact.body as {
    qualifiers?: { property?: unknown; value?: { type?: unknown; content?: unknown } }[];
  };
  const sameAs = body.qualifiers?.find(
    (qualifier) =>
      qualifier.property === 'schema:sameAs' &&
      qualifier.value?.type === 'value' &&
      typeof qualifier.value.content === 'string' &&
      /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(qualifier.value.content),
  )?.value?.content;
  return typeof sameAs === 'string' ? sameAs : null;
}

async function matchesCandidate(
  client: CommandTransaction,
  fact: FactRow,
  candidate: CurrentRelationCandidate,
): Promise<boolean> {
  if (fact.kind !== 'statement' || fact.property !== candidate.property || fact.statement_id !== candidate.candidate)
    return false;
  const body = fact.body as {
    value?: { type?: unknown; content?: unknown };
    qualifiers?: { property?: unknown; value?: { type?: unknown; content?: unknown } }[];
  };
  const value = body.value;
  const expectedValue = candidate.value ?? (candidate.target === null ? 'somevalue' : 'value');
  if (value?.type !== expectedValue) return false;
  if (candidate.target !== null && value?.content !== candidate.target) {
    if (
      typeof value?.content !== 'string' ||
      routeOf(value.content) === null ||
      (await redirectOf(client, value.content)) !== candidate.target
    )
      return false;
  }
  if (candidate.target === null && (candidate.external ?? null) !== externalValue(fact)) return false;
  if (
    candidate.filter !== undefined &&
    !candidate.filterProperties?.some((property) =>
      body.qualifiers?.some(
        (qualifier) =>
          qualifier.property === property &&
          qualifier.value?.type === 'value' &&
          qualifier.value.content === candidate.filter,
      ),
    )
  )
    return false;
  return true;
}

/**
 * Resolve only the supplied candidate keys in the caller's repeatable-read snapshot.
 * The caller releases this snapshot before preparing foreign Access evidence.
 */
export async function currentRelationFacts(
  client: CommandTransaction,
  routeKey: Uint8Array | undefined,
  candidates: readonly CurrentRelationCandidate[],
  options: { sourceFences?: 'caller' } = {},
): Promise<Map<string, FactRow>> {
  if (candidates.length > 500) throw new RangeError('Current relation checks accept at most 500 candidates');
  const facts = new Map<string, FactRow>();
  const valid: { candidate: CurrentRelationCandidate; route: number }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const route = routeOf(candidate.subject);
    if (
      route === null ||
      routeOf(candidate.candidate) !== route ||
      (candidate.slot !== undefined && routeOf(candidate.slot) !== route)
    )
      continue;
    const key = currentRelationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ candidate, route });
  }

  if (!valid.length) return facts;
  const liveRows = (await readLiveCandidates.run(client, {
    candidates: valid.map(({ candidate, route }) => ({
      route,
      subject_id: candidate.subject,
      candidate_id: candidate.candidate,
      slot_id: candidate.slot ?? null,
    })),
  })) as {
    subject_id: string;
    candidate_id: string;
    property: string | null;
    slot_id: string;
    relation: boolean;
  }[];
  const liveCandidates = new Map(liveRows.map((row) => [`${row.subject_id}\n${row.candidate_id}`, row] as const));
  const active = valid.filter(({ candidate }) => {
    const live = liveCandidates.get(`${candidate.subject}\n${candidate.candidate}`);
    return (
      live !== undefined &&
      live.property === candidate.property &&
      (candidate.slot === undefined || live.slot_id === candidate.slot) &&
      (!candidate.requireRelation || live.relation)
    );
  });
  const requested = new Map(valid.map((entry) => [currentRelationKey(entry.candidate), entry] as const));
  const compact = (await readCompactRelationCandidates.run(client, {
    candidates: active.map(({ candidate, route }) => ({
      route,
      subject_id: candidate.subject,
      property: candidate.property,
      candidate_id: candidate.candidate,
      slot_id: liveCandidates.get(`${candidate.subject}\n${candidate.candidate}`)!.slot_id,
      context_id: candidate.context ?? GLOBAL_CONTEXT,
      defaults_suppress: candidate.defaults?.[candidate.property] === 'suppress',
      require_relation: candidate.requireRelation ?? false,
    })),
  })) as {
    subject_id: string;
    candidate_id: string;
    visible: boolean;
    expanded: boolean;
    kind: FactRow['kind'] | null;
    language: string | null;
    property: string | null;
    requested_property: string;
    statement_id: string | null;
    operation: FactRow['operation'] | null;
    body: unknown;
    fact_release: string | null;
    fact_revision: number | null;
  }[];
  const compactKeys = new Set<string>();
  const fallback: typeof valid = [];
  for (const row of compact) {
    const candidate = requested.get(
      currentRelationKey({
        subject: row.subject_id,
        property: row.requested_property,
        candidate: row.candidate_id,
      }),
    );
    if (!candidate || !row.visible) continue;
    const key = currentRelationKey(candidate.candidate);
    if (row.expanded || !row.statement_id) {
      fallback.push(candidate);
      continue;
    }
    compactKeys.add(key);
    if (!row.kind || !row.property || !row.operation) continue;
    const fact: FactRow = {
      kind: row.kind,
      language: row.language,
      property: row.property,
      statement_id: row.statement_id,
      operation: row.operation,
      body: row.body,
      fact_release: row.fact_release,
      fact_revision: row.fact_revision,
    };
    if (await matchesCandidate(client, fact, candidate.candidate)) facts.set(key, fact);
  }

  if (fallback.length) {
    const groups = new Map<string, typeof fallback>();
    for (const entry of fallback) {
      const live = liveCandidates.get(`${entry.candidate.subject}\n${entry.candidate.candidate}`);
      if (!live) continue;
      const groupKey = JSON.stringify([
        entry.candidate.subject,
        entry.candidate.property,
        entry.candidate.context ?? GLOBAL_CONTEXT,
        entry.candidate.defaults ?? {},
        live.slot_id,
      ]);
      const group = groups.get(groupKey) ?? [];
      group.push(entry);
      groups.set(groupKey, group);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const slot = liveCandidates.get(`${first.candidate.subject}\n${first.candidate.candidate}`)!.slot_id;
      const view = await slotView(
        client,
        first.candidate.subject,
        first.candidate.property,
        first.candidate.context ?? GLOBAL_CONTEXT,
        first.candidate.defaults ?? {},
        slot,
      );
      for (const entry of group) {
        const fact = view.facts.find((candidate) => candidate.statement_id === entry.candidate.candidate);
        if (fact && (await matchesCandidate(client, fact, entry.candidate)))
          facts.set(currentRelationKey(entry.candidate), fact);
      }
    }
  }

  const compactDisclosures = valid.flatMap((entry) => {
    const key = currentRelationKey(entry.candidate);
    return compactKeys.has(key) && facts.has(key)
      ? [{ route: entry.route, subject_id: entry.candidate.subject, candidate_id: entry.candidate.candidate }]
      : [];
  });
  const hidden = await hiddenCandidateKeys(client, compactDisclosures);
  for (const entry of valid) {
    const key = currentRelationKey(entry.candidate);
    if (hidden.has(`${entry.candidate.subject}\n${entry.candidate.candidate}`)) facts.delete(key);
  }

  // A supplied-key caller may resolve provenance and fences on independently released source homes.
  // It must withhold these facts until both provenance and current fences have been verified.
  if (options.sourceFences === 'caller') return facts;

  const matched = valid.flatMap((entry) => {
    const fact = facts.get(currentRelationKey(entry.candidate));
    return fact ? [{ candidate: entry.candidate, route: entry.route, fact }] : [];
  });
  if (matched.length === 0) return facts;
  for (let offset = 0; offset < matched.length; offset += 256) {
    const batch = matched.slice(offset, offset + 256);
    const sources = await candidateSources(
      client,
      batch.map(({ candidate, route }) => ({
        route,
        subject_id: candidate.subject,
        candidate_id: candidate.candidate,
        ...(candidate.slot === undefined ? {} : { slot_id: candidate.slot }),
      })),
    );
    const unknown: string[] = [];
    const fenceRows: { id: string; source: CandidateSource | null }[] = [];
    for (const { candidate } of batch) {
      const key = `${candidate.subject}\n${candidate.candidate}`;
      if (!sources.has(key)) {
        unknown.push(currentRelationKey(candidate));
        continue;
      }
      const source = sources.get(key) ?? null;
      if (source && 'kind' in source) {
        if (source.kind !== 'agent' || routeOf(source.subject) === null) {
          unknown.push(currentRelationKey(candidate));
          continue;
        }
      } else if (source) {
        if (!routeKey) {
          unknown.push(currentRelationKey(candidate));
          continue;
        }
        try {
          sourceTuple(routeKey, source);
        } catch {
          unknown.push(currentRelationKey(candidate));
          continue;
        }
      }
      fenceRows.push({ id: candidate.candidate, source });
    }
    for (const key of unknown) facts.delete(key);
    const gone =
      routeKey && fenceRows.some((row) => row.source) ? await fencedIds(client, routeKey, fenceRows) : new Set();
    if (gone.size)
      for (const { candidate } of batch) if (gone.has(candidate.candidate)) facts.delete(currentRelationKey(candidate));
  }
  return facts;
}
