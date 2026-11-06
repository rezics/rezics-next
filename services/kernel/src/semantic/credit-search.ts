import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createReleasedRelationDirectionResolver, releaseDigest, type Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  CREDIT_SEARCH_LIMITS,
  currentCreditSearchMatch,
  projectCreditSearch,
  type CreditSearchEntry,
  type CreditSearchPage,
  type CreditSearchProjection,
  type CreditSearchQualifier,
  type CreditSearchSource,
  type CreditSearchWitness,
} from '../search/credit-search.ts';
import type { LanguageValue } from '../search/source.ts';
import { readRelease } from './definitions.ts';
import { withoutFencedEntries } from './fences.ts';
import { readIdentityMappings } from './identity-adapters/identity-epoch-read.ts';
import { workCreditProperties } from './list-presentation-work-context.ts';
import { indexedStatement } from './scope-leaf-selection.ts';
import readSubjects from './search-source-subjects.sql';
import readReleases from './search-source-releases.sql';
import rebuildSelection from './search-selected-rebuild.sql';
import readCreditPage from './credit-search-page.sql';
import readCreditStatement from './credit-search-statement.sql';
import readCreditNames from './credit-search-names.sql';

const ZERO = '00000000-0000-0000-0000-000000000000';
const encoder = new TextEncoder();

async function inCreditSnapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

async function readCanonicalGeneration(client: Pool | PoolClient): Promise<string> {
  const result = await client.query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value::text,is_called FROM semantic.search_canonical_generation`,
  );
  const row = result.rows[0];
  if (!row || !/^[0-9]+$/.test(row.last_value)) throw new Error('Search canonical generation is unavailable');
  return `${row.last_value}:${row.is_called ? 1 : 0}`;
}
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const digestOf = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)))
    .digest('hex');

export type CreditSearchReceipt =
  | Readonly<{ state: 'preparing' | 'unsupported' | 'unavailable' | 'incomplete' | 'changed' }>
  | Readonly<{
      state: 'complete';
      workId: string;
      observation: string;
      names: readonly CreditSearchWitness[];
    }>;
export type CreditSearchMatch = 'current' | 'changed' | 'unavailable';

type SourceSubject = {
  id: string;
  route: number;
  type: string;
  visibility: string;
  redirect: string | null;
  currentRelease: string | null;
  securityRevision: string;
  current_revision: number | null;
  selection_ready: boolean;
};
type SelectedCredit = {
  route: number;
  subject_id: string;
  slot_id: string;
  candidate_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  revision: number;
  body: unknown;
  release: string;
  source: unknown;
  relation: boolean;
  compact: boolean;
  eligible: boolean | null;
};
type NameRow = {
  id: string;
  kind: 'label' | 'alias';
  language: string | null;
  operation: 'assert' | 'retract' | string;
  body: unknown;
  slot_id: string;
  log_seq: number;
};
type WorkCut = Readonly<{
  work: SourceSubject;
  generation: string;
  ready: boolean;
}>;
type ParsedCredit = Readonly<{
  row: SelectedCredit;
  targetId: string;
  qualifiers: readonly CreditSearchQualifier[];
  overflowQualifiers: boolean;
}>;
type PublicCreator = Readonly<{
  originalId: string;
  terminalId: string;
  type: string;
  names: readonly LanguageValue[];
  namesComplete: boolean;
  nameRevision: string;
}>;

function installedLimits(input: typeof CREDIT_SEARCH_LIMITS) {
  return {
    pages: Math.min(input.pages, CREDIT_SEARCH_LIMITS.pages),
    creditsPerPage: Math.min(input.creditsPerPage, CREDIT_SEARCH_LIMITS.creditsPerPage),
    namesPerCreator: Math.min(input.namesPerCreator, CREDIT_SEARCH_LIMITS.namesPerCreator),
    qualifiersPerCredit: Math.min(input.qualifiersPerCredit, CREDIT_SEARCH_LIMITS.qualifiersPerCredit),
    nameBytes: Math.min(input.nameBytes, CREDIT_SEARCH_LIMITS.nameBytes),
    documentBytes: Math.min(input.documentBytes, CREDIT_SEARCH_LIMITS.documentBytes),
    pageBytes: Math.min(input.pageBytes, CREDIT_SEARCH_LIMITS.pageBytes),
  };
}

function observationOf(cut: WorkCut): string {
  return digestOf([
    cut.work.id,
    cut.work.type,
    cut.work.visibility,
    cut.work.redirect,
    cut.work.securityRevision,
    cut.work.currentRelease,
    cut.work.current_revision,
    cut.work.selection_ready,
    cut.generation,
  ]);
}

function cursorOf(row: Pick<SelectedCredit, 'property' | 'slot_id' | 'candidate_id'>): string {
  return JSON.stringify([row.property, row.slot_id, row.candidate_id]);
}

function readCursor(after: string | null): { property: string; slot: string; candidate: string } | null | 'invalid' {
  if (after === null) return null;
  try {
    const value = JSON.parse(after) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value.some((entry) => typeof entry !== 'string' || entry.length === 0 || !entry.isWellFormed())
    )
      return 'invalid';
    const [property, slot, candidate] = value as [string, string, string];
    if (routeOf(slot) === null || routeOf(candidate) === null) return 'invalid';
    return { property, slot, candidate };
  } catch {
    return 'invalid';
  }
}

function foldNames(rows: readonly NameRow[], nameBytes: number, namesPerCreator: number) {
  const labels = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  let overflow = rows.length > namesPerCreator * 2 + 1;
  for (const row of rows) {
    if (row.language === null || typeof row.body !== 'string') continue;
    if (row.kind === 'alias') {
      const values = aliases.get(row.language) ?? [];
      const index = values.indexOf(row.body);
      if (row.operation === 'retract') {
        if (index >= 0) values.splice(index, 1);
      } else if (index < 0) values.push(row.body);
      aliases.set(row.language, values);
      continue;
    }
    if (row.operation === 'retract') labels.delete(row.language);
    else labels.set(row.language, row.body);
  }
  const names: LanguageValue[] = [
    ...[...labels].map(([language, value]) => ({ language, value })),
    ...[...aliases].flatMap(([language, values]) => values.map((value) => ({ language, value }))),
  ].sort((left, right) => left.language.localeCompare(right.language) || left.value.localeCompare(right.value));
  const admitted: LanguageValue[] = [];
  for (const name of names) {
    if (!name.language.isWellFormed() || !name.value.isWellFormed()) {
      overflow = true;
      continue;
    }
    if (encoder.encode(name.language).byteLength > 35 || encoder.encode(name.value).byteLength > nameBytes) {
      overflow = true;
      continue;
    }
    if (admitted.length >= namesPerCreator) {
      overflow = true;
      break;
    }
    admitted.push(name);
  }
  return { names: admitted, complete: !overflow && admitted.length === names.length };
}

function parseCredit(row: SelectedCredit, release: Release, qualifiersPerCredit: number): ParsedCredit | null {
  if (row.eligible !== true || !record(row.body)) return null;
  const statement = indexedStatement(row, release);
  if (!statement || release.properties[row.property]?.datatype !== 'wikibase-item') return null;
  if (routeOf(statement.value) === null) return null;
  const rawQualifiers = Array.isArray(row.body.qualifiers) ? row.body.qualifiers : [];
  const overflowQualifiers = rawQualifiers.length > qualifiersPerCredit;
  const qualifiers = overflowQualifiers
    ? []
    : (statement.qualifiers ?? []).map((qualifier) => ({ property: qualifier.property, value: qualifier.value }));
  if (!overflowQualifiers && qualifiers.length > qualifiersPerCredit) return null;
  return { row, targetId: statement.value, qualifiers, overflowQualifiers };
}

function groups(ids: readonly string[]) {
  const result = new Map<number, { route: number; id: string }[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) continue;
    const home = partitionOf(route);
    const group = result.get(home) ?? [];
    group.push({ route, id });
    result.set(home, group);
  }
  return result;
}

async function loadReleases(client: PoolClient, digests: readonly string[]): Promise<Map<string, Release>> {
  const unique = [...new Set(digests)];
  if (!unique.length) return new Map();
  const rows = (await readReleases.run(client, { route: 0, digests: unique })) as {
    digest: string;
    body: Release;
  }[];
  const releases = new Map(rows.map((row) => [row.digest, row.body]));
  for (const digest of unique) {
    if (releases.has(digest)) continue;
    const composed = await readRelease(client, digest);
    if (composed) releases.set(digest, composed);
  }
  return releases;
}

async function loadSubjects(pool: Pool, ids: readonly string[]): Promise<Map<string, SourceSubject>> {
  const found = new Map<string, SourceSubject>();
  for (const [partition, group] of groups(ids)) {
    const rows = await inCreditSnapshot(pool, async (client) => {
      const home = await readPartition(client, partition);
      if (!home || home.writeState === 'moved') return [];
      return (await readSubjects.run(client, {
        partition_no: partition,
        routes: group.map((entry) => entry.route),
        subject_ids: group.map((entry) => entry.id),
      })) as SourceSubject[];
    });
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

async function loadNames(pool: Pool, ids: readonly string[], nameLimit: number): Promise<Map<string, NameRow[]>> {
  const names = new Map<string, NameRow[]>();
  for (const [partition, group] of groups(ids)) {
    const rows = await inCreditSnapshot(pool, async (client) => {
      const home = await readPartition(client, partition);
      if (!home || home.writeState === 'moved') return [];
      return (await readCreditNames.run(client, {
        partition_no: partition,
        routes: group.map((entry) => entry.route),
        subject_ids: group.map((entry) => entry.id),
        name_limit: nameLimit,
      })) as NameRow[];
    });
    for (const row of rows) {
      const list = names.get(row.id) ?? [];
      list.push(row);
      names.set(row.id, list);
    }
  }
  return names;
}

async function canonicalCreators(
  pool: Pool,
  originals: readonly string[],
  limits: ReturnType<typeof installedLimits>,
): Promise<{ creators: Map<string, PublicCreator>; preparing: boolean; unavailable: boolean }> {
  const unique = [...new Set(originals)];
  if (!unique.length) return { creators: new Map(), preparing: false, unavailable: false };
  const states = new Map<string, SourceSubject | null>();
  let pending = unique;
  for (let depth = 0; pending.length && depth < 8; depth++) {
    const missing = pending.filter((id) => !states.has(id));
    const loaded = await loadSubjects(pool, missing);
    const next: string[] = [];
    for (const id of missing) {
      const row = loaded.get(id) ?? null;
      states.set(id, row);
      if (row?.visibility === 'visible' && row.redirect) next.push(row.redirect);
    }
    pending = [...new Set(next)];
  }
  const terminals = new Map<string, SourceSubject>();
  for (const original of unique) {
    const seen = new Set<string>();
    let id: string | null = original;
    let terminal: SourceSubject | undefined;
    while (id) {
      if (seen.has(id)) {
        terminal = undefined;
        break;
      }
      seen.add(id);
      const row = states.get(id);
      if (!row || row.visibility !== 'visible') {
        terminal = undefined;
        break;
      }
      if (row.redirect) id = row.redirect;
      else {
        terminal = row;
        id = null;
      }
    }
    if (terminal) terminals.set(original, terminal);
  }
  const mappings = [];
  for (let offset = 0; offset < unique.length; offset += 100)
    mappings.push(...(await readIdentityMappings(pool, unique.slice(offset, offset + 100))));
  if (mappings.some((mapping) => mapping.state === 'pending'))
    return { creators: new Map(), preparing: true, unavailable: false };
  if (mappings.some((mapping) => mapping.state === 'unavailable'))
    return { creators: new Map(), preparing: false, unavailable: true };
  const mapped = new Map(unique.map((id, index) => [id, mappings[index]!] as const));
  for (const [original, mapping] of mapped) {
    if (mapping.state !== 'mapped') continue;
    const terminal = terminals.get(original);
    if (!terminal || terminal.id !== mapping.terminal) {
      const resolved = (await loadSubjects(pool, [mapping.terminal])).get(mapping.terminal);
      if (!resolved || resolved.visibility !== 'visible' || resolved.redirect)
        return { creators: new Map(), preparing: false, unavailable: false };
      terminals.set(original, resolved);
    }
  }
  const nameLimit = limits.namesPerCreator * 2 + 1;
  const nameRows = await loadNames(pool, [...new Set([...terminals.values()].map((row) => row.id))], nameLimit);
  const creators = new Map<string, PublicCreator>();
  for (const original of unique) {
    const terminal = terminals.get(original);
    if (!terminal) continue;
    const mapping = mapped.get(original);
    const folded = foldNames(nameRows.get(terminal.id) ?? [], limits.nameBytes, limits.namesPerCreator);
    creators.set(original, {
      originalId: original,
      terminalId: terminal.id,
      type: terminal.type,
      names: folded.names,
      namesComplete: folded.complete,
      nameRevision: digestOf([
        original,
        terminal.id,
        terminal.type,
        terminal.visibility,
        terminal.redirect,
        terminal.securityRevision,
        terminal.current_revision,
        mapping?.state === 'mapped' ? mapping.epoch : (mapping?.state ?? 'absent'),
        folded.names,
        folded.complete,
      ]),
    });
  }
  return { creators, preparing: false, unavailable: false };
}

async function workCut(pool: Pool, workId: string): Promise<WorkCut | 'unavailable' | 'moved'> {
  const route = routeOf(workId);
  if (route === null) return 'unavailable';
  const partition = partitionOf(route);
  return inCreditSnapshot(pool, async (client) => {
    const home = await readPartition(client, partition);
    if (!home) return 'unavailable';
    if (home.writeState === 'moved') return 'moved';
    const generation = await readCanonicalGeneration(client);
    const rows = (await readSubjects.run(client, {
      partition_no: partition,
      routes: [route],
      subject_ids: [workId],
    })) as SourceSubject[];
    const work = rows[0];
    if (!work) return 'unavailable';
    return { work, generation, ready: work.selection_ready && work.current_revision !== null };
  });
}

async function selectedCredits(
  pool: Pool,
  work: SourceSubject,
  properties: readonly string[],
  after: { property: string; slot: string; candidate: string } | null,
  limit: number,
): Promise<SelectedCredit[]> {
  if (!properties.length) return [];
  const partition = partitionOf(work.route);
  return inCreditSnapshot(pool, async (client) => {
    const home = await readPartition(client, partition);
    if (!home || home.writeState === 'moved') return [];
    return (await readCreditPage.run(client, {
      partition_no: partition,
      route: work.route,
      subject_id: work.id,
      properties: [...properties],
      has_after: after !== null,
      after_property: after?.property ?? '',
      after_slot: after?.slot ?? ZERO,
      after_candidate: after?.candidate ?? ZERO,
      page_limit: limit,
    })) as SelectedCredit[];
  });
}

async function exactCredit(
  pool: Pool,
  work: SourceSubject,
  property: string,
  statementId: string,
): Promise<SelectedCredit | undefined> {
  const partition = partitionOf(work.route);
  const rows = await inCreditSnapshot(pool, async (client) => {
    const home = await readPartition(client, partition);
    if (!home || home.writeState === 'moved') return [];
    return (await readCreditStatement.run(client, {
      partition_no: partition,
      route: work.route,
      subject_id: work.id,
      property,
      candidate_id: statementId,
    })) as SelectedCredit[];
  });
  return rows.length === 1 ? rows[0] : undefined;
}

async function creditPlan(
  pool: Pool,
  work: SourceSubject,
): Promise<{ properties: readonly string[]; releases: Map<string, Release> } | 'unsupported'> {
  const digest = work.currentRelease;
  if (!digest) return 'unsupported';
  const releases = await inCreditSnapshot(pool, async (client) => loadReleases(client, [digest]));
  const release = releases.get(digest);
  if (!release) return 'unsupported';
  const properties = workCreditProperties(
    release,
    work.type,
    createReleasedRelationDirectionResolver(release, releaseDigest(release)),
  );
  if (!properties.length) return 'unsupported';
  return { properties, releases };
}

function entriesOf(
  parsed: readonly ParsedCredit[],
  creators: ReadonlyMap<string, PublicCreator>,
  workId: string,
): CreditSearchEntry[] {
  const entries: CreditSearchEntry[] = [];
  for (const credit of parsed) {
    if (credit.overflowQualifiers) {
      entries.push({
        witness: {
          workId,
          statementId: credit.row.candidate_id,
          revision: credit.row.revision,
          release: credit.row.release,
          property: credit.row.property,
          targetId: credit.targetId,
          direction: 'outgoing',
          qualifiers: credit.qualifiers,
          nameRevision: digestOf(['overflow', credit.row.candidate_id]),
        },
        names: [],
        namesComplete: false,
      });
      continue;
    }
    const creator = creators.get(credit.targetId);
    if (!creator) continue;
    entries.push({
      witness: {
        workId,
        statementId: credit.row.candidate_id,
        revision: credit.row.revision,
        release: credit.row.release,
        property: credit.row.property,
        targetId: credit.targetId,
        direction: 'outgoing',
        qualifiers: credit.qualifiers,
        nameRevision: creator.nameRevision,
      },
      names: creator.names,
      namesComplete: creator.namesComplete,
    });
  }
  return entries;
}

async function discloseCredits(
  pool: Pool,
  routeKey: Uint8Array | undefined,
  rows: readonly SelectedCredit[],
): Promise<SelectedCredit[]> {
  if (!routeKey || !rows.length) return [...rows];
  return inCreditSnapshot(pool, async (client) =>
    withoutFencedEntries(
      client,
      routeKey,
      rows.map((row) => ({
        ...row,
        candidate_id: row.candidate_id,
        subject_id: row.subject_id,
      })),
    ),
  );
}

async function parsePage(
  pool: Pool,
  work: SourceSubject,
  rows: readonly SelectedCredit[],
  plan: Extract<Awaited<ReturnType<typeof creditPlan>>, { properties: readonly string[] }>,
  limits: ReturnType<typeof installedLimits>,
): Promise<ParsedCredit[]> {
  const digests = [...new Set(rows.map((row) => row.release).filter((digest) => !plan.releases.has(digest)))];
  if (digests.length) {
    const extra = await inCreditSnapshot(pool, async (client) => loadReleases(client, digests));
    for (const [digest, release] of extra) plan.releases.set(digest, release);
  }
  const admitted = new Set(plan.properties);
  const parsed: ParsedCredit[] = [];
  for (const row of rows) {
    if (!admitted.has(row.property)) continue;
    const release = plan.releases.get(row.release) ?? plan.releases.get(work.currentRelease ?? '');
    if (!release) continue;
    const credit = parseCredit(row, release, limits.qualifiersPerCredit);
    if (credit) parsed.push(credit);
  }
  return parsed;
}

/** Native CreditSearchSource. Pages admit selected outgoing credits before nested creator expansion. */
export function createCreditSearchSource(pool: Pool, routeKey?: Uint8Array): CreditSearchSource {
  const source: CreditSearchSource = {
    async page(input) {
      const workId = input.workId;
      if (typeof workId !== 'string' || routeOf(workId) === null) return { state: 'unavailable' };
      const limits = installedLimits(input.limits);
      const after = readCursor(input.after);
      if (after === 'invalid') return { state: 'unavailable' };
      const cut = await workCut(pool, workId);
      if (cut === 'moved' || cut === 'unavailable') return { state: 'unavailable' };
      if (cut.work.visibility !== 'visible' || cut.work.redirect) return { state: 'unavailable' };
      if (!cut.ready) {
        await rebuildSelection.run(pool, { route: cut.work.route, subject_id: workId });
        return { state: 'preparing' };
      }
      const plan = await creditPlan(pool, cut.work);
      if (plan === 'unsupported') return { state: 'unsupported' };
      const observation = observationOf(cut);
      if (input.observation !== null && input.observation !== observation)
        return { state: 'current', workId, observation, entries: [], next: null };
      const seek = await selectedCredits(pool, cut.work, plan.properties, after, limits.creditsPerPage + 1);
      const pageRows = seek.slice(0, limits.creditsPerPage);
      const next = seek.length > limits.creditsPerPage ? cursorOf(seek[limits.creditsPerPage]!) : null;
      const visible = await discloseCredits(pool, routeKey, pageRows);
      const parsed = await parsePage(pool, cut.work, visible, plan, limits);
      const expandable = parsed.filter((credit) => !credit.overflowQualifiers).map((credit) => credit.targetId);
      const creators = await canonicalCreators(pool, expandable, limits);
      if (creators.preparing) return { state: 'preparing' };
      if (creators.unavailable) return { state: 'unavailable' };
      const entries = entriesOf(parsed, creators.creators, workId);
      const page: Extract<CreditSearchPage, { state: 'current' }> = {
        state: 'current',
        workId,
        observation,
        entries,
        next,
      };
      if (bytes(page) > limits.pageBytes)
        return {
          state: 'current',
          workId,
          observation,
          entries: entries.map((entry) => ({ ...entry, names: [], namesComplete: false })),
          next,
        };
      return page;
    },

    async current(witness, observation) {
      if (witness.direction !== 'outgoing') return 'unavailable';
      const cut = await workCut(pool, witness.workId);
      if (cut === 'moved' || cut === 'unavailable') return 'unavailable';
      if (observationOf(cut) !== observation) return false;
      if (cut.work.visibility !== 'visible' || cut.work.redirect || !cut.ready) return false;
      const plan = await creditPlan(pool, cut.work);
      if (plan === 'unsupported' || !plan.properties.includes(witness.property)) return false;
      const row = await exactCredit(pool, cut.work, witness.property, witness.statementId);
      if (!row) return false;
      const visible = await discloseCredits(pool, routeKey, [row]);
      if (visible.length !== 1) return false;
      const parsed = await parsePage(pool, cut.work, visible, plan, installedLimits(CREDIT_SEARCH_LIMITS));
      const credit = parsed[0];
      if (!credit || credit.overflowQualifiers) return false;
      if (
        credit.row.revision !== witness.revision ||
        credit.row.release !== witness.release ||
        credit.row.property !== witness.property ||
        credit.targetId !== witness.targetId ||
        !isDeepStrictEqual([...credit.qualifiers], [...witness.qualifiers])
      )
        return false;
      const creators = await canonicalCreators(pool, [credit.targetId], installedLimits(CREDIT_SEARCH_LIMITS));
      if (creators.preparing) return 'unavailable';
      if (creators.unavailable) return 'unavailable';
      const creator = creators.creators.get(credit.targetId);
      if (!creator || creator.nameRevision !== witness.nameRevision) return false;
      return creator.names.some((name) => isDeepStrictEqual(name, witness.name));
    },

    async unchanged(workId, observation) {
      const cut = await workCut(pool, workId);
      if (cut === 'moved' || cut === 'unavailable') return false;
      if (cut.work.visibility !== 'visible' || cut.work.redirect || !cut.ready) return false;
      if (observationOf(cut) !== observation) return false;
      const plan = await creditPlan(pool, cut.work);
      if (plan === 'unsupported') return false;
      const limits = installedLimits(CREDIT_SEARCH_LIMITS);
      const seek = await selectedCredits(
        pool,
        cut.work,
        plan.properties,
        null,
        limits.pages * limits.creditsPerPage + 1,
      );
      const window = seek.slice(0, limits.pages * limits.creditsPerPage);
      const visible = await discloseCredits(pool, routeKey, window);
      const parsed = await parsePage(pool, cut.work, visible, plan, limits);
      const creators = await canonicalCreators(
        pool,
        parsed.filter((credit) => !credit.overflowQualifiers).map((credit) => credit.targetId),
        limits,
      );
      if (creators.preparing || creators.unavailable) return false;
      const later = await workCut(pool, workId);
      return later !== 'moved' && later !== 'unavailable' && observationOf(later) === observation;
    },
  };
  return source;
}

/** Search paging stays the owner; this maps restart onto changed for native receiving. */
export async function receiveCreditSearch(source: CreditSearchSource, workId: string): Promise<CreditSearchReceipt> {
  const projection = await projectCreditSearch(source, workId);
  if (projection.state === 'restart') return { state: 'changed' };
  if (projection.state === 'complete') return projection;
  return { state: projection.state };
}

export async function receiveCreditSearchMatch(
  source: CreditSearchSource,
  projection: CreditSearchProjection,
  matched: CreditSearchWitness,
): Promise<CreditSearchMatch> {
  const result = await currentCreditSearchMatch(source, projection, matched);
  return result === 'restart' ? 'changed' : result;
}
