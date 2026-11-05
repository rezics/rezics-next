import type { Source } from '@rezics/definitions/bulk';
import type { TermChange } from './terms.ts';
import readTermSupport from './revision-detail-term-support.sql';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { readCandidateDisclosure } from './disclosure.ts';
import { candidateSources, fencedIds } from './fences.ts';
import { withReadTransaction } from './read.ts';
import { currentAcceptance, slotView } from './slots.ts';
import { loadRelated, type SubjectComponent } from './subject.ts';
import readContext from './context-public-exists.sql';
import readVisibility from './read-visibility.sql';
import readRevision from './revision-detail-read.sql';
import readChange from './revision-detail-change.sql';
import readCandidate from './revision-detail-candidate.sql';

type Check = (client: PoolClient) => Promise<boolean>;
type Selection = { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' };
type Reading = {
  decision: { head: number; verdict: 'accept' | 'reject' | 'abstain'; revision: number } | null;
  selected: boolean;
  rank: 'normal' | 'preferred' | 'deprecated' | null;
};
export type RevisionChange =
  | { kind: 'record' }
  | { kind: 'terms'; fields: TermChange[] }
  | { kind: 'candidate'; candidate: string; property: string; context: string; reading: Reading }
  | {
      kind: 'decision';
      candidate: string;
      property: string;
      context: string;
      head: number;
      verdict: 'accept' | 'reject' | 'abstain';
      reading: Reading;
    }
  | {
      kind: 'adoption';
      property: string;
      context: string;
      head: number;
      mode: 'inherit' | 'replace' | 'suppress';
      selection: Selection[];
    };
export type RevisionDetail = {
  subject: string;
  revision: { revision: number; kind: string; release: string };
  change: RevisionChange;
};

type ChangeRow = {
  kind: string;
  candidate: string | null;
  property: string;
  slot: string;
  context: string | null;
  head: number | null;
  verdict: string | null;
  mode: string | null;
  selection: unknown;
};
function listed<T>(value: T | T[] | null): T[] {
  return value === null ? [] : Array.isArray(value) ? value : [value];
}

function relatedIds(statement: unknown, release: Release): string[] {
  const body = statement as {
    property?: string;
    value?: { type?: string; content?: unknown };
    qualifiers?: { property: string; value: { type: string; content?: unknown } }[];
    references?: { parts: { property: string; value: { type: string; content?: unknown } }[] }[];
  };
  const ids = new Set<string>();
  for (const snak of [
    body,
    ...(body.qualifiers ?? []),
    ...(body.references ?? []).flatMap((reference) => reference.parts),
  ]) {
    if (
      snak.property &&
      release.properties[snak.property]?.datatype === 'wikibase-item' &&
      snak.value?.type === 'value' &&
      typeof snak.value.content === 'string' &&
      routeOf(snak.value.content) !== null
    )
      ids.add(snak.value.content);
  }
  return [...ids];
}

/** Immutable change identity with current disclosure, never a historical Item or an actor/basis projection. */
export async function readRevisionDetail(
  pool: Pool,
  input: {
    subject: string;
    revision: number;
    routeKey: Uint8Array;
    authorize: Check;
    authorizeContext: (context: string) => Promise<Check>;
    authorizeRelated: (subject: string) => Promise<Check>;
  },
): Promise<RevisionDetail & { component: SubjectComponent }> {
  const route = routeOf(input.subject);
  if (route === null || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 2147483647)
    throw new SubjectNotFoundError();
  const parameters = { route, subject_id: input.subject, revision: input.revision };
  const first = await withReadTransaction(pool, async (client) => {
    if ((await readVisibility.run(client, parameters))?.visibility !== 'visible' || !(await input.authorize(client)))
      throw new SubjectNotFoundError();
    const revision = await readRevision.run(client, parameters);
    if (!revision) throw new SubjectNotFoundError();
    const rows = listed(await readChange.run(client, { ...parameters, kind: revision.kind })) as ChangeRow[];
    // Multi-record or legacy metadata with no exact relation has only the nonpersonal revision skeleton.
    const change = rows.length === 1 ? rows[0]! : null;
    const candidates = change?.candidate
      ? [change.candidate]
      : change?.kind === 'adoption'
        ? (change.selection as Selection[]).map((entry) => entry.candidate)
        : [];
    const candidateRows = listed(await readCandidate.run(client, { ...parameters, candidate_ids: candidates }));
    if (candidateRows.length !== candidates.length) throw new SubjectNotFoundError();
    const statements = [];
    for (const row of candidateRows) {
      if (!(await readCandidateDisclosure(client, { subject: input.subject, candidate: row.candidate }))?.disclosed)
        throw new SubjectNotFoundError();
      statements.push({
        body: { ...(row.statement as Record<string, unknown>), property: row.property },
        release: row.release,
      });
    }
    return { revision, change, candidates, statements };
  });
  const context = first.change?.context ?? GLOBAL_CONTEXT;
  // Prepare foreign authority only after releasing the Subject checkout (including pool max 1).
  const contextCheck = first.change ? await input.authorizeContext(context) : null;
  // A later decision's release is not the proposing candidate's datatype authority.
  const releases = new Map<string, Release>();
  for (const digest of new Set(first.statements.map((statement) => statement.release))) {
    const release = await readRelease(pool, digest);
    if (!release) throw new SubjectNotFoundError();
    releases.set(digest, release);
  }
  const targets = [
    ...new Set(first.statements.flatMap((statement) => relatedIds(statement.body, releases.get(statement.release)!))),
  ];
  if (targets.length > 256) throw new SubjectNotFoundError();
  const redirects = await withReadTransaction(pool, async (client) => {
    const states = await loadRelated({ query: client.query.bind(client) }, targets);
    return new Map(targets.map((id) => [id, states.get(id)?.redirect ?? null]));
  });
  const terminals = [...new Set([...redirects.values()].filter((id): id is string => id !== null))];
  const related = new Map<string, Check>();
  for (const id of new Set([...targets, ...terminals])) related.set(id, await input.authorizeRelated(id));
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (
      !partition ||
      (await readVisibility.run(client, parameters))?.visibility !== 'visible' ||
      !(await input.authorize(client))
    )
      throw new SubjectNotFoundError();
    if (
      contextCheck &&
      (!(await readContext.run(client, { route: routeOf(context)!, context_id: context })) ||
        !(await contextCheck(client)))
    )
      throw new SubjectNotFoundError();
    for (const candidate of first.candidates)
      if (!(await readCandidateDisclosure(client, { subject: input.subject, candidate }))?.disclosed)
        throw new SubjectNotFoundError();
    const sources = await candidateSources(
      client,
      first.candidates.map((candidate) => ({ route, subject_id: input.subject, candidate_id: candidate })),
    );
    if (
      (
        await fencedIds(
          client,
          input.routeKey,
          first.candidates.map((id) => ({ id, source: sources.get(`${input.subject}\n${id}`) ?? null })),
        )
      ).size
    )
      throw new SubjectNotFoundError();
    const relatedClient = { query: client.query.bind(client) };
    const states = await loadRelated(relatedClient, targets);
    const terminalStates = await loadRelated(relatedClient, terminals);
    for (const [id, check] of related) {
      const state = states.get(id) ?? terminalStates.get(id);
      if (state?.visibility !== 'visible' || !(await check(client))) throw new SubjectNotFoundError();
      if (targets.includes(id) ? state.redirect !== redirects.get(id) : state.redirect !== null)
        throw new SubjectNotFoundError();
    }
    let change: RevisionChange = { kind: 'record' };
    if (first.revision.kind === 'terms') {
      const support = listed(
        await readTermSupport.run(client, {
          ...parameters,
          revisions: (first.revision.term_support ?? []).map((revision) => revision!),
        }),
      );
      if (
        support.length !== (first.revision.term_support ?? []).length ||
        (
          await fencedIds(
            client,
            input.routeKey,
            support.map((row) => ({ id: String(row.revision), source: row.source as Source | null })),
          )
        ).size
      )
        throw new SubjectNotFoundError();
      change = { kind: 'terms', fields: first.revision.term_changes as TermChange[] };
    }
    const row = first.change;
    if (row?.kind === 'candidate' || row?.kind === 'decision') {
      const candidate = row.candidate!;
      const decision = await currentAcceptance(client, input.subject, candidate, context);
      const view = await slotView(client, input.subject, row.property, context, {}, row.slot);
      const current = view.facts.find((fact) => fact.statement_id === candidate);
      const reading: Reading = {
        decision,
        selected: current !== undefined,
        rank: current ? ((current.body as { rank: Reading['rank'] }).rank ?? 'normal') : null,
      };
      change =
        row.kind === 'candidate'
          ? { kind: 'candidate', candidate, property: row.property, context, reading }
          : {
              kind: 'decision',
              candidate,
              property: row.property,
              context,
              head: row.head!,
              verdict: row.verdict as 'accept' | 'reject' | 'abstain',
              reading,
            };
    } else if (row?.kind === 'adoption') {
      // The immutable selection describes this adoption only; it never asserts it is the current reading.
      change = {
        kind: 'adoption',
        property: row.property,
        context,
        head: row.head!,
        mode: row.mode as 'inherit' | 'replace' | 'suppress',
        selection: row.selection as Selection[],
      };
    }
    return {
      subject: input.subject,
      revision: { revision: first.revision.revision, kind: first.revision.kind, release: first.revision.release },
      change,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
}
