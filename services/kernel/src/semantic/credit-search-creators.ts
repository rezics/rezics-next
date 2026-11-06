import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { LanguageValue } from '../search/source.ts';
import type { IdentityMapping } from './identity-adapters/identity-epoch-contract.ts';
import { readIdentityMappings } from './identity-adapters/read.ts';
import { digestOf, encoder, type CreditSearchCeilings, type WorkHeader } from './credit-search-cut.ts';
import { inCreditSnapshot } from './credit-search-selection.ts';
import readSubjects from './search-source-subjects.sql';
import readCreditNames from './credit-search-names.sql';

export type NameRow = {
  id: string;
  kind: 'label' | 'alias';
  language: string | null;
  operation: 'assert' | 'retract' | string;
  body: unknown;
  slot_id: string;
  log_seq: number;
};

export type PublicCreator = Readonly<{
  originalId: string;
  terminalId: string;
  type: string;
  names: readonly LanguageValue[];
  namesComplete: boolean;
  nameRevision: string;
}>;

export type CreatorResolution =
  | { state: 'preparing' }
  | { state: 'unavailable' }
  | { state: 'current'; creators: Map<string, PublicCreator> };

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

export async function loadSubjects(pool: Pool, ids: readonly string[]): Promise<Map<string, WorkHeader>> {
  const found = new Map<string, WorkHeader>();
  for (const [partition, group] of groups(ids)) {
    const rows = await inCreditSnapshot(pool, async (client) => {
      const home = await readPartition(client, partition);
      if (!home || home.writeState === 'moved') return [];
      return (await readSubjects.run(client, {
        partition_no: partition,
        routes: group.map((entry) => entry.route),
        subject_ids: group.map((entry) => entry.id),
      })) as WorkHeader[];
    });
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

export async function loadNames(
  pool: Pool,
  ids: readonly string[],
  nameLimit: number,
): Promise<Map<string, NameRow[]>> {
  const names = new Map<string, NameRow[]>();
  if (!ids.length) return names;
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

export function foldNames(rows: readonly NameRow[], nameBytes: number, namesPerCreator: number, fetchLimit: number) {
  const labels = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  let overflow = rows.length >= fetchLimit;
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

async function followVisible(
  states: Map<string, WorkHeader | null>,
  original: string,
): Promise<WorkHeader | undefined> {
  const seen = new Set<string>();
  let id: string | null = original;
  while (id) {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const row = states.get(id);
    if (!row || row.visibility !== 'visible') return undefined;
    if (row.redirect) id = row.redirect;
    else return row;
  }
  return undefined;
}

async function identityOf(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]> {
  const mappings: IdentityMapping[] = [];
  for (let offset = 0; offset < originals.length; offset += 100)
    mappings.push(...(await readIdentityMappings(pool, originals.slice(offset, offset + 100))));
  return mappings;
}

function mappingEpoch(mapping: IdentityMapping | undefined): string {
  if (!mapping) return 'absent';
  if (mapping.state === 'mapped') return mapping.epoch.toString();
  if (mapping.state === 'pending') return `pending:${mapping.job.jobId}:${mapping.job.epoch.toString()}`;
  if (mapping.state === 'unavailable') return `unavailable:${mapping.reason}`;
  return mapping.state;
}

/** Public creator labels/aliases and identity terminals. Pending identity is preparing; moved homes are unavailable. */
export async function canonicalCreators(
  pool: Pool,
  originals: readonly string[],
  limits: CreditSearchCeilings,
): Promise<CreatorResolution> {
  const unique = [...new Set(originals)];
  if (!unique.length) return { state: 'current', creators: new Map() };
  const states = new Map<string, WorkHeader | null>();
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
  const mappings = await identityOf(pool, unique);
  if (mappings.some((mapping) => mapping.state === 'pending')) return { state: 'preparing' };
  if (mappings.some((mapping) => mapping.state === 'unavailable' && mapping.reason === 'moved-owner'))
    return { state: 'unavailable' };
  const mapped = new Map(unique.map((id, index) => [id, mappings[index]!] as const));
  const terminals = new Map<string, WorkHeader>();
  for (const original of unique) {
    const mapping = mapped.get(original);
    if (mapping?.state === 'mapped') {
      const known = states.get(mapping.terminal);
      const resolved = known ?? (await loadSubjects(pool, [mapping.terminal])).get(mapping.terminal);
      if (!resolved || resolved.visibility !== 'visible' || resolved.redirect) continue;
      terminals.set(original, resolved);
      continue;
    }
    const terminal = await followVisible(states, original);
    if (terminal) terminals.set(original, terminal);
  }
  const nameLimit = limits.namesPerCreator * 2 + 1;
  const nameRows = await loadNames(pool, [...new Set([...terminals.values()].map((row) => row.id))], nameLimit);
  const creators = new Map<string, PublicCreator>();
  for (const original of unique) {
    const terminal = terminals.get(original);
    if (!terminal) continue;
    const mapping = mapped.get(original);
    const folded = foldNames(nameRows.get(terminal.id) ?? [], limits.nameBytes, limits.namesPerCreator, nameLimit);
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
        mappingEpoch(mapping),
        folded.names,
        folded.complete,
      ]),
    });
  }
  return { state: 'current', creators };
}
