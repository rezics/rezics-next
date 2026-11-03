import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import { createAccountTokenProvider, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { createImportTransport, type ReviewedSubjectRead } from './import-client.ts';
import { createImporter, type ImportRunResult } from './importer.ts';
import { createSourceRegistration } from './source-registry.ts';

type Provider = 'bangumi' | 'vndb';
type Row = Record<string, unknown>;
export type Franchise = 'steins-gate' | 'clannad' | 'fate';
const patterns: Record<Franchise, RegExp> = {
  'steins-gate': /^(?:STEINS[;；]GATE|シュタインズ[・･]ゲート|命运石之门)(?:$|[\s:：0])/i,
  clannad: /^CLANNAD(?:$|[\s:：])/i,
  fate: /^(?:Fate\s*[/／]|フェイト\s*[/／])/i,
};
export const crossMediaAliases = { bangumi: 'bangumi_cross_media', vndb: 'vndb_cross_media' } as const;

/** Membership uses titles only, never synopsis mentions, credits or a shared actor. */
export function crossMediaFranchise(...names: unknown[]): Franchise | undefined {
  return (Object.keys(patterns) as Franchise[]).find((family) =>
    names.some((name) => typeof name === 'string' && patterns[family].test(name.trim())),
  );
}

export interface CrossMediaTables {
  rows(provider: Provider, table: string): AsyncIterable<Row>;
}
export type CrossMediaGap = {
  source: Provider;
  /** Exact dump columns, including qualifications, ordering and original endpoint IDs. */
  fields: string[];
  record: Row;
  reason: string;
};
export type CrossMediaPlan = {
  records: Record<Provider, SourceRecord[]>;
  franchises: Record<Franchise, { bangumi: string[]; vndb: string[] }>;
  gaps: CrossMediaGap[];
};
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function text(row: Row, field: string): string {
  const value = row[field];
  ensure(typeof value === 'string' && value.length > 0, `Missing source field: ${field}`);
  return value;
}
function number(row: Row, field: string): number {
  const value = row[field];
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `Invalid Bangumi ${field}`);
  return value;
}

/** Select a finite named catalogue; unsupported native rows remain explicit source gaps.
 * Ported selection/incident-edge shape: legacy-final:scripts/datasets/{bangumi,vndb}.ts.
 * This stage deliberately does not equate two providers' works or people by their names.
 */
export async function planCrossMediaSeed(input: CrossMediaTables): Promise<CrossMediaPlan> {
  const plan: CrossMediaPlan = {
    records: { bangumi: [], vndb: [] },
    franchises: {
      'steins-gate': { bangumi: [], vndb: [] },
      clannad: { bangumi: [], vndb: [] },
      fate: { bangumi: [], vndb: [] },
    },
    gaps: [],
  };
  const gap = (
    source: Provider,
    table: string,
    record: Row,
    reason = 'No registered native converter for this source relation or entity',
  ) => {
    plan.gaps.push({
      source,
      fields: Object.keys(record)
        .sort()
        .map((field) => `${table}.${field}`),
      record,
      reason,
    });
  };
  const works = new Set<number>(),
    characters = new Set<number>(),
    persons = new Set<number>();
  const anime = new Set<Franchise>();
  for await (const row of input.rows('bangumi', 'subject')) {
    const family = crossMediaFranchise(row.name, row.name_cn);
    if (!family) continue;
    const id = number(row, 'id');
    ensure(!works.has(id), 'Duplicate selected Bangumi subject');
    if (![1, 2, 4].includes(row.type as number)) {
      gap('bangumi', 'subject', row, 'Source work type is outside the registered Bangumi conversion scope');
      continue;
    }
    works.add(id);
    if (row.type === 2) anime.add(family);
    plan.franchises[family].bangumi.push(String(id));
    plan.records.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
  }
  for await (const row of input.rows('bangumi', 'subject-relations'))
    if (works.has(number(row, 'subject_id')) || works.has(number(row, 'related_subject_id')))
      gap('bangumi', 'subject-relations', row);
  for await (const row of input.rows('bangumi', 'subject-characters'))
    if (works.has(number(row, 'subject_id'))) characters.add(number(row, 'character_id'));
  // Retain other appearances of the elected characters, including outside the named catalogue.
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    if (!works.has(number(row, 'subject_id'))) continue;
    persons.add(number(row, 'person_id'));
    gap('bangumi', 'subject-persons', row);
  }
  for await (const row of input.rows('bangumi', 'person-characters')) {
    if (!works.has(number(row, 'subject_id')) && !characters.has(number(row, 'character_id'))) continue;
    persons.add(number(row, 'person_id'));
    characters.add(number(row, 'character_id'));
    gap('bangumi', 'person-characters', row);
  }
  for await (const row of input.rows('bangumi', 'subject-characters'))
    if (characters.has(number(row, 'character_id'))) gap('bangumi', 'subject-characters', row);
  const corePersons = new Set(persons),
    coreCharacters = new Set(characters);
  for await (const row of input.rows('bangumi', 'person-relations')) {
    ensure(row.person_type === 'prsn' || row.person_type === 'crt', 'Unknown Bangumi person_type');
    const core = row.person_type === 'prsn' ? corePersons : coreCharacters;
    if (!core.has(row.person_id as number) && !core.has(row.related_person_id as number)) continue;
    gap('bangumi', 'person-relations', row);
    const all = row.person_type === 'prsn' ? persons : characters;
    // Keep malformed upstream endpoints in the gap instead of inventing a native identity.
    if (typeof row.person_id === 'number') all.add(row.person_id);
    if (typeof row.related_person_id === 'number') all.add(row.related_person_id);
  }
  for (const [table, ids] of [
    ['character', characters],
    ['person', persons],
  ] as const)
    for await (const row of input.rows('bangumi', table)) if (ids.has(number(row, 'id'))) gap('bangumi', table, row);
  for await (const row of input.rows('bangumi', 'episode'))
    if (works.has(number(row, 'subject_id'))) gap('bangumi', 'episode', row);

  const vnIds = new Set<string>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const family = crossMediaFranchise(row.title, row.latin);
    if (!family) continue;
    const id = text(row, 'id');
    ensure(/^v[1-9][0-9]*$/.test(id), 'Invalid VNDB work identity');
    vnIds.add(id);
    if (!plan.franchises[family].vndb.includes(id)) plan.franchises[family].vndb.push(id);
  }
  const titles = new Map<string, Row[]>(),
    vns = new Map<string, Row>(),
    revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(row.official === 't' || row.official === 'f', 'Invalid VNDB official title flag');
    const title = { ...row, official: row.official === 't' };
    titles.set(id, [...(titles.get(id) ?? []), title]);
  }
  for await (const row of input.rows('vndb', 'vn')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(!vns.has(id), 'Duplicate selected VNDB work');
    vns.set(id, row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(!revisions.has(id), 'Duplicate selected VNDB revision');
    ensure(/^[1-9][0-9]*$/.test(text(row, 'revision')), 'Invalid VNDB revision');
    revisions.set(id, { id, revision: Number(row.revision), lastmod: row.lastmod });
  }
  for (const id of vnIds) {
    const row = vns.get(id),
      entry_meta = revisions.get(id);
    ensure(row && entry_meta && titles.has(id), `Missing selected VNDB record: ${id}`);
    const vn: Row = { id, olang: row.olang, ...(row.alias === null ? {} : { alias: row.alias }) };
    if (row.c_votecount !== undefined || row.c_average !== undefined) {
      ensure(
        typeof row.c_votecount === 'string' && /^(?:0|[1-9][0-9]*)$/.test(row.c_votecount),
        'Invalid VNDB vote count',
      );
      ensure(
        row.c_average === null || (typeof row.c_average === 'string' && /^(?:0|[1-9][0-9]*)$/.test(row.c_average)),
        'Invalid VNDB average',
      );
      vn.c_votecount = Number(row.c_votecount);
      vn.c_average = row.c_average === null ? null : Number(row.c_average);
    }
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: titles.get(id)! },
    });
  }
  const releases = new Set<string>(),
    chars = new Set<string>(),
    aliases = new Set<string>(),
    staff = new Set<string>();
  for await (const row of input.rows('vndb', 'vn_relations'))
    if (vnIds.has(text(row, 'id')) || vnIds.has(text(row, 'vid'))) gap('vndb', 'vn_relations', row);
  for await (const row of input.rows('vndb', 'releases_vn'))
    if (vnIds.has(text(row, 'vid'))) releases.add(text(row, 'id'));
  for await (const row of input.rows('vndb', 'releases_vn'))
    if (releases.has(text(row, 'id'))) gap('vndb', 'releases_vn', row);
  for (const table of ['vn_staff', 'vn_seiyuu'])
    for await (const row of input.rows('vndb', table)) {
      if (!vnIds.has(text(row, 'id'))) continue;
      aliases.add(text(row, 'aid'));
      if (table === 'vn_seiyuu') chars.add(text(row, 'cid'));
      gap('vndb', table, row);
    }
  for await (const row of input.rows('vndb', 'chars_vns')) if (vnIds.has(text(row, 'vid'))) chars.add(text(row, 'id'));
  for await (const row of input.rows('vndb', 'chars_vns'))
    if (chars.has(text(row, 'id'))) gap('vndb', 'chars_vns', row);
  for await (const row of input.rows('vndb', 'staff_alias'))
    if (aliases.has(text(row, 'aid'))) staff.add(text(row, 'id'));
  for (const [table, ids] of [
    ['staff_alias', staff],
    ['staff', staff],
    ['chars', chars],
    ['releases', releases],
  ] as const)
    for await (const row of input.rows('vndb', table)) if (ids.has(text(row, 'id'))) gap('vndb', table, row);
  for await (const row of input.rows('vndb', 'vn_anime'))
    if (vnIds.has(text(row, 'id')))
      gap('vndb', 'vn_anime', row, 'VNDB anime.aid is an AniDB identifier, not a Bangumi or native subject identity');
  // Preserve release relations, staff affiliations and external links in the same explicit gap channel.
  const producers = new Set<string>(),
    animeIds = new Set<string>(),
    links = new Set<string>();
  for (const [table, ids] of [
    ['releases_producers', releases],
    ['releases_supersedes', releases],
    ['releases_titles', releases],
    ['staff_extlinks', staff],
    ['vn_extlinks', vnIds],
  ] as const)
    for await (const row of input.rows('vndb', table)) {
      if (!ids.has(text(row, 'id'))) continue;
      gap('vndb', table, row);
      if (table === 'releases_producers') producers.add(text(row, 'pid'));
      if (table.endsWith('_extlinks')) links.add(text(row, 'link'));
    }
  for await (const row of input.rows('vndb', 'staff'))
    if (staff.has(text(row, 'id')) && typeof row.prod === 'string') producers.add(row.prod);
  for await (const row of input.rows('vndb', 'vn_anime'))
    if (vnIds.has(text(row, 'id'))) animeIds.add(text(row, 'aid'));
  for (const [table, ids] of [
    ['producers', producers],
    ['anime', animeIds],
    ['extlinks', links],
  ] as const)
    for await (const row of input.rows('vndb', table)) if (ids.has(text(row, 'id'))) gap('vndb', table, row);

  for (const family of Object.keys(patterns) as Franchise[])
    ensure(anime.has(family) && plan.franchises[family].vndb.length, `Missing anime/VN pair for ${family}`);
  // Validate every registered conversion before opening state or contacting an API.
  for (const provider of ['bangumi', 'vndb'] as const) {
    const registration = createSourceRegistration(provider, { source: crossMediaAliases[provider] });
    for (const row of plan.records[provider])
      registration.convert(
        { external_id: row.key, record_revision: row.revision, record: row.payload },
        { source: registration.source },
      );
    plan.records[provider].sort((a, b) => a.key.localeCompare(b.key));
  }
  for (const family of Object.values(plan.franchises)) {
    family.bangumi.sort();
    family.vndb.sort();
  }
  return plan;
}

/** PostgreSQL COPY text escaping, ported from legacy-final:scripts/datasets/vndb.ts. */
export function decodeCrossMediaCopy(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_match, code: string) => {
    const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
    return escapes[code] ?? code;
  });
}

/** Extracted official dump tables only. No remote acquisition, SQL execution or platform database access. */
export class CrossMediaDumpFiles implements CrossMediaTables {
  readonly digests = new Map<string, string>();
  constructor(
    private readonly bangumi: string,
    private readonly vndb: string,
  ) {}
  async *rows(provider: Provider, table: string): AsyncGenerator<Row> {
    ensure(/^[a-z][a-z_-]*$/.test(table), 'Invalid dump table name');
    const file = provider === 'bangumi' ? join(this.bangumi, `${table}.jsonlines`) : join(this.vndb, 'db', table);
    const header = provider === 'vndb' ? await readFile(`${file}.header`) : null;
    const columns = header ? header.toString('utf8').trimEnd().split('\t') : null;
    if (columns) {
      ensure(columns.length > 0 && new Set(columns).size === columns.length, 'Invalid VNDB header');
      const headerKey = `${provider}/${table}.header`,
        hash = createHash('sha256').update(header!).digest('hex');
      ensure(!this.digests.has(headerKey) || this.digests.get(headerKey) === hash, 'Dump changed during selection');
      this.digests.set(headerKey, hash);
    }
    const stream = createReadStream(file);
    const digest = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    async function* lines() {
      let pending = '';
      for await (const chunk of stream) {
        digest.update(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          ensure(Buffer.byteLength(pending.slice(0, end)) <= 1024 * 1024, 'Dump row exceeds seed input limit');
          yield pending.slice(0, end).replace(/\r$/, '');
          pending = pending.slice(end + 1);
        }
        ensure(Buffer.byteLength(pending) <= 1024 * 1024, 'Dump row exceeds seed input limit');
      }
      pending += decoder.decode();
      if (pending) yield pending;
    }
    try {
      for await (const line of lines()) {
        if (!line) continue;
        ensure(Buffer.byteLength(line) <= 1024 * 1024, 'Dump row exceeds seed input limit');
        if (columns) {
          const cells = line.split('\t');
          ensure(cells.length === columns.length, `Invalid VNDB column count: ${table}`);
          yield Object.fromEntries(columns.map((column, i) => [column, decodeCrossMediaCopy(cells[i]!)]));
        } else {
          const row: unknown = JSON.parse(line);
          ensure(row && typeof row === 'object' && !Array.isArray(row), 'Invalid Bangumi row');
          yield row as Row;
        }
      }
    } finally {
      stream.destroy();
    }
    const key = `${provider}/${table}`,
      hash = digest.digest('hex');
    ensure(!this.digests.has(key) || this.digests.get(key) === hash, 'Dump changed during selection');
    this.digests.set(key, hash);
  }
}

export type CrossMediaPort = Pick<
  ReturnType<typeof createImportTransport>,
  | 'batch'
  | 'setSourceRecordMetadata'
  | 'fence'
  | 'writeSourceStatistic'
  | 'clearSourceStatistic'
  | 'readReviewedSubject'
>;
export async function seedCrossMedia(plan: CrossMediaPlan, path: string, port: CrossMediaPort) {
  const importer = createImporter({
    path,
    transport: {
      batchWrite: (request) => port.batch(request),
      setSourceRecordMetadata: (request, signal) => port.setSourceRecordMetadata(request, signal),
      readFence: (tuple) =>
        port.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
      writeSourceStatistic: (request, signal) => port.writeSourceStatistic(request, signal),
      clearSourceStatistic: (request, signal) => port.clearSourceStatistic(request, signal),
    },
  });
  const runs: Partial<Record<Provider, ImportRunResult>> = {};
  const readings: { source: Provider; externalId: string; subject: ReviewedSubjectRead }[] = [];
  try {
    for (const provider of ['bangumi', 'vndb'] as const) {
      const registration = createSourceRegistration(provider, { source: crossMediaAliases[provider] });
      async function* records() {
        yield* plan.records[provider];
      }
      const run = await importer.runRecords(registration, records());
      ensure(run.status === 'committed', `Cross-media ${provider} import failed: ${run.status}`);
      runs[provider] = run;
      for (const record of plan.records[provider]) {
        const claim = importer.session.bindings.claim({ source: registration.source, external_id: record.key });
        ensure(claim?.state === 'bound', `Cross-media ${provider} record is not bound`);
        readings.push({
          source: provider,
          externalId: record.key,
          subject: await port.readReviewedSubject(claim.subject),
        });
      }
    }
    return { status: 'imported-with-gaps' as const, franchises: plan.franchises, runs, readings, gaps: plan.gaps };
  } finally {
    await importer.close();
  }
}

export async function runCrossMediaSeedCli(argv: readonly string[]): Promise<void> {
  const flags = [
    '--bangumi',
    '--vndb',
    '--state',
    '--result',
    '--api',
    '--auth',
    '--account-key',
    '--account',
    '--client',
  ];
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      `Usage: bun scripts/datasets/cross-media-seed.ts ${flags.map((flag) => `${flag} <value>`).join(' ')}\n`,
    );
    return;
  }
  ensure(argv.length === flags.length * 2, 'Expected explicit cross-media seed configuration');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!,
      value = argv[i + 1]!;
    ensure(
      flags.includes(flag) && !values.has(flag) && value && value.length <= 4096 && !value.includes('\0'),
      'Invalid seed option',
    );
    values.set(flag, value);
  }
  const origin = (flag: string) => {
    const url = new URL(values.get(flag)!);
    ensure(
      url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
      'Seed API and Auth require HTTPS origins',
    );
    return url.origin;
  };
  const api = origin('--api'),
    auth = origin('--auth');
  const input = new CrossMediaDumpFiles(values.get('--bangumi')!, values.get('--vndb')!);
  const plan = await planCrossMediaSeed(input);
  const tokenProvider = await createAccountTokenProvider({
    accountKeyPath: values.get('--account-key')!,
    account: values.get('--account')!,
    client: values.get('--client')!,
    authOrigin: auth,
    scopes: [...VNDB_IMPORTER_SCOPES, 'subject:read'],
  });
  const resultPath = resolve(values.get('--result')!);
  const statePath = resolve(values.get('--state')!);
  ensure(
    resultPath !== statePath && ![`${statePath}-wal`, `${statePath}-shm`].includes(resultPath),
    'Result must not overwrite importer state',
  );
  await mkdir(dirname(statePath), { recursive: true });
  const result = await seedCrossMedia(plan, statePath, createImportTransport({ origin: api, tokenProvider }));
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ ...result, sourceDigests: Object.fromEntries(input.digests) }, null, 2)}\n`,
  );
  process.stdout.write(
    `Imported ${result.readings.length} works; ${result.gaps.length} source gaps. Result: ${resultPath}\n`,
  );
}
