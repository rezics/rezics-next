import { readFileSync } from 'node:fs';
import type { Acquisition } from './network.ts';
import { blobPath } from './store.ts';
import type { DatasetEdge, DatasetImage, DatasetRecord, DatasetSource } from './types.ts';

export const VNDB_DUMP_URL = 'https://dl.vndb.org/dump/vndb-db-2026-10-02.tar.zst';
export type CopyRow = Record<string, string | null>;

/** PostgreSQL COPY text is not ordinary TSV: escaped tabs/newlines stay in a cell. */
export function decodeCopyCell(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_match, code: string) => {
    const escapes: Record<string, string> = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
    };
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
    return escapes[code] ?? code;
  });
}

/** Buffer views avoid copying the 1.18 GB dump or decoding excluded personal-list tables. */
export class VndbDump {
  readonly entries = new Map<string, Buffer>();
  readonly headers = new Map<string, string[]>();
  constructor(bytes: Uint8Array) {
    const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < archive.length;) {
      if (offset + 512 > archive.length) throw new Error('Truncated VNDB tar header');
      const header = archive.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
      if (!name) break;
      if (name.startsWith('/') || name.split('/').includes('..'))
        throw new Error('Unsafe VNDB tar entry');
      const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim();
      if (!/^[0-7]+$/.test(sizeText)) throw new Error(`Invalid VNDB tar size: ${name}`);
      const size = parseInt(sizeText, 8);
      if (offset + 512 + size > archive.length)
        throw new Error(`Truncated VNDB tar entry: ${name}`);
      if (this.entries.has(name)) throw new Error(`Duplicate VNDB tar entry: ${name}`);
      this.entries.set(name, archive.subarray(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    for (const [name, bytes] of this.entries)
      if (name.startsWith('db/') && name.endsWith('.header')) {
        this.headers.set(name.slice(3, -7), bytes.toString().trimEnd().split('\t'));
      }
  }
  *rows(
    table: string,
    filter?: { column: string; values: ReadonlySet<string> },
  ): Generator<CopyRow> {
    const bytes = this.entries.get(`db/${table}`),
      columns = this.headers.get(table);
    if (!bytes || !columns) throw new Error(`Missing VNDB table: ${table}`);
    const selectedColumn = filter ? columns.indexOf(filter.column) : -1;
    if (filter && selectedColumn < 0)
      throw new Error(`Missing VNDB column: ${table}.${filter.column}`);
    for (let start = 0; start < bytes.length;) {
      let end = bytes.indexOf(10, start);
      if (end < 0) end = bytes.length;
      const line = bytes.subarray(start, end).toString();
      start = end + 1;
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length !== columns.length) throw new Error(`VNDB COPY column count: ${table}`);
      if (filter && !filter.values.has(fields[selectedColumn]!)) continue;
      yield Object.fromEntries(
        columns.map((column, index) => [column, decodeCopyCell(fields[index]!)]),
      );
    }
  }
}

const key = (kind: string, id: string) => `vndb:${kind}:${id}`;
const seriesRelation = new Set(['preq', 'seq', 'side', 'set', 'alt', 'ser', 'par', 'orig']);
export function fateTitle(value: string | null): boolean {
  return (
    value !== null &&
    /^(?:Fate\s*(?:[/／\\]|(?:Grand\s+Order|Prototype|EXTRA|EXTELLA|stay\s+night|hollow\s+ataraxia)\b)|フェイト\s*[/／\\]|FGO$)/i.test(
      value.trim(),
    )
  );
}

export async function fetchVndb(acquisition: Acquisition): Promise<DatasetSource> {
  const capture = await acquisition.capture(VNDB_DUMP_URL, { limit: 512 * 1024 * 1024 });
  const archived = readFileSync(blobPath(acquisition.root, capture.digest));
  const dump = new VndbDump(Bun.zstdDecompressSync(archived));
  return selectFate(dump, {
    url: capture.url,
    digest: capture.digest,
    fetchedAt: capture.fetchedAt,
  });
}

export function selectFate(
  dump: VndbDump,
  provenance: Record<string, unknown> = {},
): DatasetSource {
  const records = new Map<string, DatasetRecord>(),
    edges: DatasetEdge[] = [],
    images: DatasetImage[] = [];
  const titles = [...dump.rows('vn_titles')];
  const roots = new Set(
    titles.filter((row) => fateTitle(row.title) || fateTitle(row.latin)).map((row) => row.id!),
  );
  for (const row of dump.rows('vn')) if (row.alias?.split('\n').some(fateTitle)) roots.add(row.id!);
  if (!roots.has('v11')) throw new Error('Fate/stay night v11 missing from pinned VNDB selection');
  const family = new Set(roots),
    relations = [...dump.rows('vn_relations')];
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of relations)
      if (row.official === 't' && seriesRelation.has(row.relation!)) {
        if (family.has(row.id!) && !family.has(row.vid!)) {
          family.add(row.vid!);
          changed = true;
        }
        if (family.has(row.vid!) && !family.has(row.id!)) {
          family.add(row.id!);
          changed = true;
        }
      }
  }
  const selected = new Map<string, Set<string>>();
  const ids = (kind: string) => {
    let values = selected.get(kind);
    if (!values) selected.set(kind, (values = new Set()));
    return values;
  };
  for (const id of family) ids('vn').add(id);
  const primaryVns = new Set(family);
  const electedTables: Record<string, CopyRow[]> = {};
  const remember = (table: string, rows: CopyRow[]) => {
    electedTables[table] = rows;
    return rows;
  };
  const take = (table: string, column: string, values: ReadonlySet<string>) =>
    remember(table, [...dump.rows(table, { column, values })]);
  const refs = (rows: CopyRow[], column: string, kind: string) => {
    for (const row of rows) if (row[column] !== null) ids(kind).add(row[column]!);
  };
  const familyRelations = remember(
    'vn_relations',
    relations.filter((row) => family.has(row.id!)),
  );
  refs(familyRelations, 'vid', 'vn');
  refs(take('releases_vn', 'vid', family), 'id', 'release');
  // Bundle releases retain every component, including works outside the Fate family.
  refs(take('releases_vn', 'id', ids('release')), 'vid', 'vn');
  changed = true;
  const supersedes = [...dump.rows('releases_supersedes')];
  while (changed) {
    changed = false;
    for (const row of supersedes)
      if (ids('release').has(row.id!) && !ids('release').has(row.rid!)) {
        ids('release').add(row.rid!);
        changed = true;
      }
  }
  remember(
    'releases_supersedes',
    supersedes.filter((row) => ids('release').has(row.id!)),
  );
  refs(take('releases_vn', 'id', ids('release')), 'vid', 'vn');
  const seiyuu = take('vn_seiyuu', 'id', primaryVns),
    credits = take('vn_staff', 'id', primaryVns);
  const quotes = take('quotes', 'vid', primaryVns);
  refs(quotes, 'cid', 'character');
  refs(seiyuu, 'cid', 'character');
  const appearances = [...dump.rows('chars_vns')];
  refs(
    appearances.filter((row) => primaryVns.has(row.vid!)),
    'id',
    'character',
  );
  const allCharacters = [...dump.rows('chars')];
  changed = true;
  while (changed) {
    changed = false;
    for (const row of allCharacters)
      if (ids('character').has(row.id!) && row.main && !ids('character').has(row.main)) {
        ids('character').add(row.main);
        changed = true;
      }
  }
  const selectedAppearances = remember(
    'chars_vns',
    appearances.filter((row) => ids('character').has(row.id!)),
  );
  refs(selectedAppearances, 'vid', 'vn');
  refs(selectedAppearances, 'rid', 'release');
  // Screenshots/covers can cite a specific release or bundled work outside the family.
  refs(take('vn_screenshots', 'id', primaryVns), 'rid', 'release');
  refs(take('releases_images', 'id', ids('release')), 'vid', 'vn');
  changed = true;
  while (changed) {
    changed = false;
    for (const row of supersedes)
      if (ids('release').has(row.id!) && !ids('release').has(row.rid!)) {
        ids('release').add(row.rid!);
        changed = true;
      }
  }
  remember(
    'releases_supersedes',
    supersedes.filter((row) => ids('release').has(row.id!)),
  );
  refs(take('releases_vn', 'id', ids('release')), 'vid', 'vn');
  const aliases = [...dump.rows('staff_alias')];
  const staffAliases = new Set([...seiyuu, ...credits].map((row) => row.aid!));
  for (const alias of aliases) if (staffAliases.has(alias.aid!)) ids('staff').add(alias.id!);
  const tagVotes = take('tags_vn', 'vid', primaryVns);
  refs(tagVotes, 'tag', 'tag');
  refs(take('chars_traits', 'id', ids('character')), 'tid', 'trait');
  const traits = [...dump.rows('traits')];
  for (const [kind, table] of [
    ['tag', 'tags_parents'],
    ['trait', 'traits_parents'],
  ] as const) {
    const parents = [...dump.rows(table)];
    changed = true;
    while (changed) {
      changed = false;
      for (const row of parents)
        if (ids(kind).has(row.id!) && !ids(kind).has(row.parent!)) {
          ids(kind).add(row.parent!);
          changed = true;
        }
      if (kind === 'trait')
        for (const row of traits)
          if (ids(kind).has(row.id!) && row.gid && !ids(kind).has(row.gid)) {
            ids(kind).add(row.gid);
            changed = true;
          }
    }
    remember(
      table,
      parents.filter((row) => ids(kind).has(row.id!)),
    );
  }
  refs(take('releases_producers', 'id', ids('release')), 'pid', 'producer');
  const staff = take('staff', 'id', ids('staff'));
  refs(staff, 'prod', 'producer');
  const primaryProducers = new Set(ids('producer'));
  const producerRelations = [...dump.rows('producers_relations')];
  refs(
    remember(
      'producers_relations',
      producerRelations.filter((row) => primaryProducers.has(row.id!)),
    ),
    'pid',
    'producer',
  );
  // Every elected identity retains every scalar column. Tables below retain all owned rows.
  const entities = [
    ['vn', 'vn', 'work'],
    ['release', 'releases', 'release'],
    ['character', 'chars', 'character'],
    ['staff', 'staff', 'person'],
    ['producer', 'producers', 'organization'],
    ['tag', 'tags', 'concept'],
    ['trait', 'traits', 'concept'],
  ] as const;
  for (const [kind, table, native] of entities) {
    const rows =
      table === 'chars'
        ? remember(
            table,
            allCharacters.filter((row) => ids(kind).has(row.id!)),
          )
        : take(table, 'id', ids(kind));
    for (const row of rows)
      records.set(key(kind, row.id!), {
        key: key(kind, row.id!),
        provider: 'vndb',
        kind,
        externalId: row.id!,
        title: row.name ?? row.id!,
        language: row.olang ?? row.lang ?? 'und',
        sourceUrl: `https://vndb.org/${row.id}`,
        native,
        data: { ...row, tables: {} },
        ...(kind === 'vn' ? { semanticTypes: ['https://schema.org/VideoGame'] } : {}),
      });
  }
  const ownedTables: Record<string, string[]> = {
    vn: [
      'vn_titles',
      'vn_anime',
      'vn_editions',
      'vn_extlinks',
      'vn_screenshots',
      'vn_image_votes',
      'vn_length_votes',
    ],
    release: [
      'releases_titles',
      'releases_drm',
      'releases_extlinks',
      'releases_images',
      'releases_media',
      'releases_platforms',
    ],
    character: ['chars_alias', 'chars_names'],
    staff: ['staff_alias', 'staff_extlinks'],
    producer: ['producers_extlinks'],
  };
  for (const [kind, tables] of Object.entries(ownedTables))
    for (const table of tables)
      take(
        table,
        table === 'vn_image_votes' || table === 'vn_length_votes' ? 'vid' : 'id',
        kind === 'vn' && table !== 'vn_titles' ? primaryVns : ids(kind),
      );
  // Quotations and catalogue dependencies are first-class source-only records.
  refs(electedTables.vn_anime ?? [], 'aid', 'anime');
  refs(electedTables.releases_drm ?? [], 'drm', 'drm');
  refs(electedTables.releases ?? [], 'engine', 'engine');
  for (const rows of Object.values(electedTables))
    for (const row of rows) if (row.link) ids('external-link').add(row.link);
  for (const row of quotes)
    records.set(key('quote', row.id!), {
      key: key('quote', row.id!),
      provider: 'vndb',
      kind: 'quote',
      externalId: row.id!,
      title: row.quote!,
      language: 'und',
      sourceUrl: `https://vndb.org/${row.id}`,
      native: 'source-only',
      data: row,
    });
  for (const [kind, table, title] of [
    ['anime', 'anime', 'title_romaji'],
    ['drm', 'drm', 'name'],
    ['engine', 'engines', 'name'],
    ['external-link', 'extlinks', 'value'],
  ] as const) {
    for (const row of take(table, 'id', ids(kind)))
      records.set(key(kind, row.id!), {
        key: key(kind, row.id!),
        provider: 'vndb',
        kind,
        externalId: row.id!,
        title: row[title] ?? row.id!,
        language: 'und',
        sourceUrl:
          kind === 'anime' ? `https://anidb.net/anime/${row.id}` : `https://vndb.org/d14#${table}`,
        native: 'source-only',
        data: row,
      });
  }
  for (const row of electedTables.extlinks ?? [])
    if (row.site === 'wikidata') ids('wikidata').add(row.value!);
  for (const row of take('wikidata', 'id', ids('wikidata')))
    records.set(key('wikidata', row.id!), {
      key: key('wikidata', row.id!),
      provider: 'vndb',
      kind: 'wikidata',
      externalId: row.id!,
      title: `Wikidata Q${row.id}`,
      language: 'und',
      sourceUrl: `https://www.wikidata.org/wiki/Q${row.id}`,
      native: 'source-only',
      data: row,
    });
  const imageUrls = new Map<string, string>();
  const image = (kind: string, id: string, role: string, imageId: string | null) => {
    if (!imageId) return;
    ids('image').add(imageId);
    const match = /^(cv|ch|sf)(\d+)$/.exec(imageId);
    if (!match) throw new Error(`Unknown VNDB image identity: ${imageId}`);
    const url = `https://t.vndb.org/${match[1]}/${String(Number(match[2]) % 100).padStart(2, '0')}/${match[2]}.jpg`;
    imageUrls.set(imageId, url);
    images.push({ record: key(kind, id), role, url });
  };
  for (const record of records.values()) {
    if (record.kind === 'vn') {
      image('vn', record.externalId, 'cover', record.data.image as string | null);
      image('vn', record.externalId, 'selected-cover', record.data.c_image as string | null);
    }
    if (record.kind === 'character')
      image('character', record.externalId, 'portrait', record.data.image as string | null);
  }
  for (const row of electedTables.vn_screenshots ?? []) image('vn', row.id!, 'screenshot', row.scr);
  for (const row of electedTables.releases_images ?? [])
    image(
      'release',
      row.id!,
      row.itype === 'pkgfront' ? 'cover:release:pkgfront' : `release:${row.itype}`,
      row.img,
    );
  for (const row of electedTables.vn_image_votes ?? [])
    image('vn', row.vid!, 'candidate-cover', row.img);
  for (const row of take('images', 'id', ids('image')))
    records.set(key('image', row.id!), {
      key: key('image', row.id!),
      provider: 'vndb',
      kind: 'image',
      externalId: row.id!,
      title: row.id!,
      language: 'und',
      sourceUrl: imageUrls.get(row.id!)!,
      native: 'source-only',
      data: row,
    });
  take('image_votes', 'id', ids('image'));
  const entryIds = new Set([...records.values()].map((record) => record.externalId));
  take('entry_meta', 'id', entryIds);
  const owner: Record<string, string> = Object.fromEntries(
    entities.map(([kind, table]) => [table, kind]),
  );
  for (const [table, rows] of Object.entries(electedTables))
    for (const row of rows) {
      const kind =
        table === 'tags_vn' || table.startsWith('vn_')
          ? 'vn'
          : table.startsWith('releases_')
            ? 'release'
            : table.startsWith('chars_')
              ? 'character'
              : table.startsWith('staff_')
                ? 'staff'
                : table.startsWith('producers_')
                  ? 'producer'
                  : table === 'tags_parents'
                    ? 'tag'
                    : table === 'traits_parents'
                      ? 'trait'
                      : table === 'image_votes'
                        ? 'image'
                        : owner[table];
      const record =
        table === 'entry_meta'
          ? [...records.values()].find((record) => record.externalId === row.id)
          : kind
            ? records.get(
                key(
                  kind,
                  (table === 'tags_vn' || table === 'vn_image_votes' || table === 'vn_length_votes'
                    ? row.vid
                    : row.id)!,
                ),
              )
            : undefined;
      if (!record || table === entities.find(([, name]) => name === table)?.[1]) continue;
      const tables = (record.data.tables ??= {}) as Record<string, CopyRow[]>;
      (tables[table] ??= []).push(row);
    }
  const addEdge = (
    fromKind: string,
    from: string,
    toKind: string,
    to: string | null,
    kind: string,
    data: CopyRow,
  ) => {
    if (to === null) return;
    if (!records.has(key(fromKind, from)) || !records.has(key(toKind, to)))
      throw new Error(`Missing VNDB relationship endpoint: ${kind} ${from} -> ${to}`);
    edges.push({ from: key(fromKind, from), to: key(toKind, to), kind, data });
  };
  for (const row of familyRelations)
    addEdge('vn', row.id!, 'vn', row.vid, `vn:${row.relation}`, row);
  for (const row of electedTables.releases_vn!)
    addEdge('release', row.id!, 'vn', row.vid, 'release-of', row);
  for (const row of electedTables.releases_producers!)
    addEdge('release', row.id!, 'producer', row.pid, 'producer', row);
  for (const row of electedTables.releases_supersedes!)
    addEdge('release', row.id!, 'release', row.rid, 'supersedes', row);
  for (const row of selectedAppearances)
    addEdge('character', row.id!, 'vn', row.vid, 'appearance', row);
  for (const row of electedTables.chars_traits!)
    addEdge('character', row.id!, 'trait', row.tid, 'trait', row);
  for (const row of tagVotes) addEdge('vn', row.vid!, 'tag', row.tag, 'tag-vote', row);
  for (const [kind, table] of [
    ['tag', 'tags_parents'],
    ['trait', 'traits_parents'],
    ['producer', 'producers_relations'],
  ] as const)
    for (const row of electedTables[table]!)
      addEdge(kind, row.id!, kind, row.parent ?? row.pid!, 'parent', row);
  const aliasIds = new Map(aliases.map((row) => [row.aid!, row.id!]));
  for (const row of credits)
    addEdge('vn', row.id!, 'staff', aliasIds.get(row.aid!) ?? null, `credit:${row.role}`, row);
  for (const row of seiyuu) {
    addEdge('vn', row.id!, 'staff', aliasIds.get(row.aid!) ?? null, 'voice-actor', row);
    addEdge('character', row.cid!, 'staff', aliasIds.get(row.aid!) ?? null, 'voice-actor', row);
  }
  for (const row of electedTables.vn_anime!)
    addEdge('vn', row.id!, 'anime', row.aid, 'anime-adaptation', row);
  for (const row of electedTables.releases_drm!)
    addEdge('release', row.id!, 'drm', row.drm, 'drm', row);
  for (const row of electedTables.releases!)
    addEdge('release', row.id!, 'engine', row.engine, 'engine', row);
  for (const row of staff) addEdge('staff', row.id!, 'producer', row.prod, 'affiliation', row);
  for (const row of traits.filter((row) => ids('trait').has(row.id!)))
    addEdge('trait', row.id!, 'trait', row.gid, 'trait-group', row);
  for (const row of allCharacters.filter((row) => ids('character').has(row.id!)))
    addEdge('character', row.id!, 'character', row.main, 'character-version', row);
  for (const row of quotes) {
    addEdge('quote', row.id!, 'vn', row.vid, 'quote-from', row);
    addEdge('quote', row.id!, 'character', row.cid, 'speaker', row);
  }
  for (const [kind, table] of [
    ['vn', 'vn_extlinks'],
    ['release', 'releases_extlinks'],
    ['staff', 'staff_extlinks'],
    ['producer', 'producers_extlinks'],
  ] as const)
    for (const row of electedTables[table]!)
      addEdge(kind, row.id!, 'external-link', row.link, 'external-link', row);
  for (const row of electedTables.extlinks!)
    if (row.site === 'wikidata')
      addEdge('external-link', row.id!, 'wikidata', row.value, 'wikidata', row);
  for (const record of records.values()) {
    const tables = record.data.tables as Record<string, CopyRow[]> | undefined;
    const names =
      tables?.vn_titles ?? tables?.releases_titles ?? tables?.chars_names ?? tables?.staff_alias;
    const named =
      (record.kind === 'staff' ? names?.find((row) => row.aid === record.data.main) : undefined) ??
      names?.find(
        (row) => (row.lang ?? record.language) === record.language && (row.title || row.name),
      ) ??
      names?.find((row) => row.title || row.name);
    if (named) record.title = named.title ?? named.name ?? record.title;
  }
  for (const record of records.values())
    if (record.kind === 'release' && record.title === record.externalId) {
      const components = electedTables
        .releases_vn!.filter((row) => row.id === record.externalId)
        .map((row) => records.get(key('vn', row.vid!))?.title)
        .filter(Boolean);
      if (components.length) record.title = `${components.join(' / ')} (${record.externalId})`;
    }
  return {
    provider: 'vndb',
    roots: [...roots].sort().map((id) => key('vn', id)),
    records: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
    edges,
    images: [...new Map(images.map((item) => [JSON.stringify(item), item])).values()],
    scope: {
      ...provenance,
      selection:
        'Fate/ or フェイト/ original/romanized titles and aliases, known Fate brand names/FGO, plus official prequel/sequel/side-story/setting/alternative/series/parent/original-game closure.',
      family: [...family].sort(),
      familyCount: family.size,
      namedRootCount: roots.size,
      referenceVns: [...ids('vn')].filter((id) => !family.has(id)).sort(),
      primaryProducers: [...primaryProducers].sort(),
      referenceProducers: [...ids('producer')].filter((id) => !primaryProducers.has(id)).sort(),
      included: Object.keys(electedTables).sort(),
      headers: Object.fromEntries(dump.headers),
      completeness:
        'Full scalar records and elected owned tables from one pinned dump. All family releases, bundled works, characters, staff, direct producers, tags/traits and ancestors. Cross-franchise VN appearance/relationship targets and company relationship frontier retain complete scalar records/names/external links; their own catalogue neighborhoods are not recursively expanded.',
      excluded: [
        'Personal users/reading lists/release lists',
        'Unrelated catalogue neighborhoods',
        'Unlinked Wikidata rows',
      ],
      license:
        'ODbL + DbCL with archive README exceptions: Wikidata CC0, Anime CC BY-NC-SA, descriptions may have separate conditions. Original README and all license files retained in captured dump.',
    },
  };
}
