import { expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  type BatchCommand,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { documentText, parseDocument } from '@rezics/document';
import { assertGrowth } from '../services/kernel/test/support/growth-bound';
import { checkGrowth } from '../services/kernel/test/support/growth';
import { countedSample, countedViolations, validateCountedRun } from '../services/kernel/test/support/growth-counters';
import { costOf } from '../services/kernel/test/support/growth-cost';
import { assertIndexedSqlite } from './support/verify-import-api';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Counters,
  Dump,
  Exchange,
  ImportApiDriver,
  Proposal,
  RecordView,
  Run,
  Source,
} from './imports-api-driver';

setDefaultTimeout(120_000);
const encoder = new TextEncoder();
const files = {
  bangumi: 'bangumi.jsonl',
  vndb: 'vndb.sql',
  openlibrary: 'openlibrary.tsv',
  wikidata: 'wikidata.jsonl',
};
const keys = { bangumi: '1', vndb: 'v1', openlibrary: '/works/OL1W', wikidata: 'Q1' };
const urls = {
  bangumi: 'https://bgm.tv/subject/1',
  vndb: 'https://vndb.org/v1',
  openlibrary: 'https://openlibrary.org/works/OL1W',
  wikidata: 'https://www.wikidata.org/wiki/Q1?oldid=101',
};
const sourceMetadata = {
  bangumi: {
    recordUrl: urls.bangumi,
    summary: { language: 'und', takedownEligible: true },
    cover: { role: 'cover', creditLine: '(c) rights holder via Bangumi', takedownEligible: true },
  },
  vndb: { databaseLicense: 'ODbL-1.0', contentsLicense: 'LicenseRef-DbCL-1.0', attribution: 'VNDB' },
  openlibrary: { recordUrl: urls.openlibrary, bibliographyPermission: 'CC0-1.0' },
  wikidata: { license: 'CC0-1.0', attribution: 'Wikidata contributors', url: urls.wikidata },
};
const coverUrl = 'https://lain.bgm.tv/cover.jpg';
async function scenario(action: (d: ImportApiDriver) => Promise<void>) {
  const location = process.env.IMPORT_API_DRIVER;
  if (!location) throw new Error('IMPORT_API_DRIVER is required: bind the real importer and public API');
  if (!isAbsolute(location) && !location.startsWith('file:')) throw new Error('IMPORT_API_DRIVER must be absolute');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_API_DRIVER must use a file URL');
  const binding = await import(url.href);
  const d: ImportApiDriver = await binding.createImportApiDriver({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
  });
  try {
    await action(d);
  } finally {
    await d.close();
  }
}
async function dump(source: Source): Promise<Dump> {
  const input: Dump = {
    source,
    snapshot: '2020-01-01',
    converterRevision: 'conversion-v1',
    bytes: new Uint8Array(
      await Bun.file(new URL(`./fixtures/imports/api/${files[source]}`, import.meta.url)).arrayBuffer(),
    ),
  };
  if (source === 'vndb') {
    // Synthetic realistic public COPY TO STDOUT entries; original fixtures stay intact.
    const tables = {
      vn: [
        (await Bun.file(new URL('./fixtures/imports/vndb-tables/db/vn.header', import.meta.url)).text()).trimEnd(),
        'v1\t\\N\t\\N\ten\t0\t\\N\t\\N\t\\N\t0\t0\t0\tJourney\tUNLICENSED_DESCRIPTION_SENTINEL\nv2\t\\N\t\\N\ten\t0\t\\N\t\\N\t\\N\t0\t0\t0\tSecond\tUNLICENSED_DESCRIPTION_SENTINEL',
      ],
      vn_titles: [
        'id\tlang\tofficial\ttitle\tlatin',
        'v1\ten\tt\tA Catalogue Journey\t\\N\nv2\ten\tt\tA Second Journey\t\\N',
      ],
      entry_meta: [
        'id\tcreated\tlastmod\trevision\tnum_edits\tnum_users',
        'v1\t2020-01-01\t2020-01-01\t7\t6\t3\nv2\t2020-01-02\t2020-01-02\t19\t18\t4',
      ],
    };
    const entries = Object.entries(tables).flatMap(([name, [header, rows]]) => [
      { path: `db/${name}.header`, bytes: encoder.encode(header + '\n') },
      { path: `db/${name}`, bytes: encoder.encode(rows + '\n') },
    ]);
    input.bytes = new Uint8Array();
    input.entries = () =>
      (async function* () {
        for (const item of entries) {
          let passes = 0,
            consumed = 0;
          yield {
            path: item.path,
            kind: 'file' as const,
            declaredBytes: item.bytes.length,
            bytes: {
              async *[Symbol.asyncIterator]() {
                expect(++passes).toBe(1);
                for (let offset = 0; offset < item.bytes.length; offset += 7) {
                  const chunk = item.bytes.subarray(offset, offset + 7);
                  consumed += chunk.length;
                  yield chunk;
                }
              },
            },
          };
          expect(passes).toBe(1);
          expect(consumed).toBe(item.bytes.length);
        }
      })();
  }
  return input;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function content(p: Proposal) {
  return p.statement?.value.content;
}
function references(p: Proposal) {
  return [...p.references, ...(p.statement?.references ?? [])].flatMap((r) =>
    r.parts.map((part) => part.value.content),
  );
}
function field(view: RecordView, property: string, value: unknown) {
  const matches = view.proposals.filter(
    (p) =>
      p.kind === 'value' &&
      p.statement?.property.id === property &&
      (property === 'schema:name' ? (content(p) as { text?: string })?.text === value : content(p) === value),
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}
function retrieved(view: RecordView) {
  expect(view.responses.length).toBeGreaterThan(0);
  for (const response of view.responses) expect(response.status).toBe(200);
  const bodies = JSON.stringify(view.responses.map((r) => r.body));
  for (const p of view.proposals) {
    expect(bodies).toContain(p.id);
    if (p.statement) {
      expect(bodies).toContain(p.statement.id);
      expect(bodies).toContain(JSON.stringify(p.statement));
    }
    for (const reference of p.references) expect(bodies).toContain(JSON.stringify(reference));
    expect(view.revisions.some((r) => r.proposalIds.includes(p.id))).toBe(true);
  }
}
function stored(view: RecordView) {
  return {
    subject: view.subject,
    proposals: view.proposals,
    retracted: view.retracted,
    revisions: view.revisions,
    adopted: view.adopted,
  };
}
async function summaryField(d: ImportApiDriver, view: RecordView, text: string) {
  const proposals = view.proposals.filter((p) => p.statement?.property.id === d.properties.summary);
  for (const proposal of proposals) {
    const actual = await d.document(proposal);
    expect(actual.response.status).toBe(200);
    expect(JSON.stringify(proposal.statement)).toContain(actual.stored.id);
    expect(JSON.stringify(proposal.statement)).toContain(actual.stored.digest);
    expect(actual.response.bytes).toEqual(actual.stored.bytes);
    expect(actual.stored.digest).toBe(sha256(actual.response.bytes));
    const snapshot = parseDocument(JSON.parse(new TextDecoder().decode(actual.response.bytes)));
    expect(snapshot.profile).toBe('text');
    expect(actual.response.bytes.length).toBeLessThanOrEqual(32768);
    expect(actual.semantic).toMatchObject({
      documentId: actual.stored.id,
      digest: actual.stored.digest,
      body: null,
      transactionId: actual.stored.transactionId,
    });
    expect(actual.stored.rights).toMatchObject({
      license: 'CC-BY-SA-3.0',
      obligations: expect.arrayContaining(['cc:Attribution', 'cc:ShareAlike']),
    });
    expect(actual.stored.rights.attribution).toMatch(/Bangumi.*contributors/i);
    expect(actual.semantic.language.length).toBeGreaterThan(0);
    if (documentText(snapshot) === text) return proposal;
  }
  throw new Error(`Missing disclosed full summary: ${text}`);
}
async function coverField(d: ImportApiDriver, proposal: Proposal) {
  expect(typeof content(proposal)).toBe('string');
  expect(String(content(proposal))).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  const media = await d.media(proposal);
  expect(media.id).toBe(String(content(proposal)));
  expect(media.state).toBe('available');
  expect(media.transitions).toEqual(['reserved', 'uploaded', 'available']);
  expect(media.role).toBe('cover');
  expect(media.credit).toEqual({
    rightsHolder: '(c) rights holder',
    via: { name: 'Bangumi', url: urls.bangumi },
    license: 'LicenseRef-unknown',
    obligations: [],
  });
  expect(JSON.stringify(media.provenance)).toContain(urls.bangumi);
  expect(media.sharedSharpPipeline).toBe(true);
  const transport = media.transport;
  expect(new URL(transport.request.url).pathname).toBe('/v1/media:importFromUrl');
  expect(transport.request.method).toBe('POST');
  expect(transport.request.headers.get('authorization')).toMatch(/^Bearer \S+$/);
  expect(checkMediaImportRequest(transport.request.body)).toEqual([]);
  expect(transport.request.body).toEqual({
    containerId: proposal.subjectId,
    sourceUrl: coverUrl,
    credit: {
      rightsHolder: '(c) rights holder',
      via: { name: 'Bangumi', url: urls.bangumi },
      license: 'LicenseRef-unknown',
      obligations: [],
    },
    provenance: {
      source: proposal.source,
      external_id: proposal.externalId,
      record_revision: proposal.recordRevision,
      converter_revision: proposal.converterRevision,
      digest: proposal.recordDigest,
      field_group: 'cover',
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: urls.bangumi } },
            { property: { id: 'schema:url' }, value: { type: 'value', content: coverUrl } },
          ],
        },
      ],
    },
  });
  expect(media.provenance).toEqual((transport.request.body as MediaImportRequest).provenance);
  expect(transport.verifiedSub).toBe(transport.importerId);
  expect(transport.websiteSession).toBe(false);
  expect(transport.serviceToken).toBe(false);
  expect(transport.importerFetchedBytes).toBe(0);
  expect(transport.contentFetches).toContain(coverUrl);
  expect(media.response.status).toBe(200);
  expect(media.response.headers.get('location')).toBeNull();
  expect(media.response.url).not.toBe(coverUrl);
  expect(media.response.bytes).toEqual(media.storedBytes);
  expect(media.response.bytes).not.toEqual(media.sourceBytes);
  expect(media.digest).toBe(sha256(media.storedBytes));
  expect(sha256(media.response.bytes)).toBe(media.digest);
  return media;
}
function wireCommands(exchange: Exchange): BatchCommand[] {
  expect(checkBatchWrite(exchange.request.body)).toEqual([]);
  expect(JSON.parse(exchange.request.serializedBody)).toEqual(exchange.request.body);
  expect(encoder.encode(exchange.request.serializedBody).length).toBeLessThanOrEqual(65536);
  const commands = (exchange.request.body as { commands: BatchCommand[] }).commands;
  expect(exchange.request.keys).toEqual(commands.map((command) => command.key));
  expect(new Set(exchange.request.keys).size).toBe(commands.length);
  for (const key of exchange.request.keys) expect(key.length).toBeGreaterThan(0);
  return commands;
}
async function completedBaseline(d: ImportApiDriver, source: Source, records: number, previous: string | null) {
  const baseline = await d.baseline(source);
  expect(typeof baseline.snapshot).toBe('string');
  expect(baseline.snapshot!.length).toBeGreaterThan(0);
  expect(baseline.snapshot).not.toBe(previous);
  expect(baseline.records).toBe(records);
  return baseline;
}
async function commandReceipts(d: ImportApiDriver, exchange: Exchange) {
  wireCommands(exchange);
  expect(checkBatchWriteResult(exchange.response.body)).toEqual([]);
  const result = exchange.response.body as unknown as BatchWriteResult;
  expect(result.results.map((entry) => entry.key).sort()).toEqual([...exchange.request.keys].sort());
  expect(exchange.receipts.map((receipt) => receipt.key)).toEqual(exchange.request.keys);
  for (const receipt of exchange.receipts) {
    expect(typeof receipt.identity).toBe('string');
    expect(receipt.identity!.length).toBeGreaterThan(0);
    expect(await d.receipt(receipt.key)).toBe(receipt.identity);
  }
}
async function launch(d: ImportApiDriver, source: Source) {
  const input = await dump(source),
    before = await d.effects(),
    baseline = await d.baseline(source);
  let run!: Run;
  const measured = await d.measure(async () => {
    run = await d.run(input);
  });
  for (const phase of ['reader', 'converter'] as const) {
    expect(measured[phase].statements).toBe(0);
    expect(measured[phase].rowsReturned).toBe(0);
    expect(measured[phase].partitions).toBe(0);
    expect(measured[phase].sqlite.executions).toEqual([]);
    expect(measured[phase].postgres.statements).toEqual([]);
    expect(measured[phase].postgres.plans).toEqual([]);
    expect(costOf(measured[phase].postgres).blocks).toBe(0);
  }
  expect(run.outcome).toBe('complete');
  expect(run.exchanges.length).toBeGreaterThan(0);
  for (const x of run.exchanges) {
    expect(x.request.method).toBe('POST');
    expect(new URL(x.request.url).pathname).toBe('/v1/subjects:batchWrite');
    expect(checkBatchWrite(x.request.body)).toEqual([]);
    expect((x.request.body as { commands: unknown[] }).commands.length).toBeLessThanOrEqual(100);
    expect(encoder.encode(JSON.stringify(x.request.body)).length).toBeLessThanOrEqual(65536);
    expect(x.request.headers.get('authorization')).toMatch(/^Bearer \S+$/);
    await commandReceipts(d, x);
    expect(x.response.status).toBeGreaterThanOrEqual(200);
    expect(x.response.status).toBeLessThan(300);
  }
  const view = await d.read(source, keys[source]);
  retrieved(view);
  expect(view.subject).not.toBeNull();
  expect(d.properties.title).toBe('schema:name');
  expect(d.properties.summary).toBe('schema:abstract');
  expect(d.properties.cover).toBe('schema:image');
  const title = field(view, d.properties.title, 'A Catalogue Journey');
  expect(content(title)).toMatchObject({ language: expect.any(String), text: 'A Catalogue Journey' });
  for (const p of view.proposals) {
    expect(p).toMatchObject({ source, externalId: keys[source], converterRevision: input.converterRevision });
    expect(p.recordDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.recordRevision.length).toBeGreaterThan(0);
    expect(p.subjectId).toBe(view.subject!.id);
    expect(references(p)).toContain(source === 'vndb' ? `${urls[source]}.${p.recordRevision}` : urls[source]);
  }
  expect(run.conversions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceMetadata: expect.objectContaining(sourceMetadata[source]) }),
    ]),
  );
  for (const command of d.commands(run)) {
    if (command.source.field_group === 'facts') expect(command).not.toHaveProperty('rights');
  }
  if (source === 'bangumi') expect(title.recordRevision).toBe('unversioned');
  if (source === 'vndb') expect(title.recordRevision).toBe('7');
  if (source === 'openlibrary') expect(title.recordRevision).toBe('1');
  if (source === 'wikidata') expect(title.recordRevision).toBe('101');
  const after = await d.effects();
  expect(after.subjects - before.subjects).toBe(2);
  expect(after.proposals - before.proposals).toBeGreaterThanOrEqual(2);
  expect(after.revisions - before.revisions).toBeGreaterThanOrEqual(2);
  expect(after.proposals - before.proposals).toBe(
    (await d.read(source, keys[source])).proposals.length +
      (await d.read(source, { bangumi: '2', vndb: 'v2', openlibrary: '/works/OL2W', wikidata: 'Q2' }[source])).proposals
        .length,
  );
  await completedBaseline(d, source, 2, baseline.snapshot);
  return { input, view };
}
async function catalogue(count: number, changed = false): Promise<Dump> {
  const input = await dump('bangumi');
  const template = JSON.parse(new TextDecoder().decode(input.bytes).split('\n')[0]!);
  input.bytes = encoder.encode(
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({ ...template, id: i + 1, name: `${changed ? 'Changed' : 'Original'} ${i + 1}` }),
    ).join('\n') + (count ? '\n' : ''),
  );
  input.snapshot = changed ? '2020-01-02' : '2020-01-01';
  return input;
}
test('Bangumi dump preserves summary rights and separately credited cover', () =>
  scenario(async (d) => {
    const { view } = await launch(d, 'bangumi');
    const summary = await summaryField(d, view, 'A traveller builds a catalogue.');
    expect(references(summary)).toContain(urls.bangumi);
    const cover = view.proposals.find((p) => p.statement?.property.id === d.properties.cover)!;
    expect(cover).toBeDefined();
    await coverField(d, cover);
  }));
test('VNDB COPY dump preserves permitted factual rights and source references', () =>
  scenario(async (d) => {
    const { view } = await launch(d, 'vndb');
    expect(JSON.stringify(view)).not.toContain('UNLICENSED_DESCRIPTION_SENTINEL');
    expect(references(field(view, d.properties.title, 'A Catalogue Journey'))).toContain('https://vndb.org/v1.7');
  }));
test('unsupported inline VNDB COPY fixture has no effects or checkpoint', () =>
  scenario(async (d) => {
    const input = await dump('vndb');
    delete input.entries;
    input.bytes = new Uint8Array(
      await Bun.file(new URL('./fixtures/imports/api/vndb.sql', import.meta.url)).arrayBuffer(),
    );
    const before = await d.effects(),
      baseline = await d.baseline('vndb');
    const run = await d.run(input);
    expect(run.outcome).toBe('invalid-input');
    expect(run.exchanges).toEqual([]);
    expect(run.vanished).toEqual([]);
    expect(await d.effects()).toEqual(before);
    expect(await d.baseline('vndb')).toEqual(baseline);
  }));
test('truncated public VNDB table streams and mismatched headers cannot publish or checkpoint', () =>
  scenario(async (d) => {
    const input = await dump('vndb');
    expect((await d.run(input)).outcome).toBe('complete');
    const before = await d.effects(),
      baseline = await d.baseline('vndb');
    const view = await d.read('vndb', 'v1');
    for (const mode of ['truncated', 'header'] as const) {
      const entries: NonNullable<Dump['entries']> = () =>
        (async function* () {
          for await (const entry of input.entries!()) {
            if (entry.path === (mode === 'header' ? 'db/vn_titles.header' : 'db/entry_meta')) {
              const original = entry.bytes;
              yield {
                ...entry,
                bytes: (async function* () {
                  for await (const chunk of original) {
                    if (mode === 'header') yield encoder.encode('wrong\tcolumns\n');
                    else yield chunk.subarray(0, 1);
                  }
                })(),
              };
            } else yield entry;
          }
        })();
      const run = await d.run({ ...input, snapshot: '2020-01-02', entries });
      expect(run.outcome).toBe('invalid-input');
      expect(run.exchanges).toEqual([]);
      expect(run.vanished).toEqual([]);
      expect(await d.effects()).toEqual(before);
      expect(await d.baseline('vndb')).toEqual(baseline);
      expect(stored(await d.read('vndb', 'v1'))).toEqual(stored(view));
    }
  }));
test('Open Library five-column TSV imports through public bulk API', () =>
  scenario(async (d) => {
    await launch(d, 'openlibrary');
  }));
test('Wikidata JSON lines retain references without fabricating native external IDs', () =>
  scenario(async (d) => {
    const { view } = await launch(d, 'wikidata');
    const external = field(view, d.properties.externalId, 'OL999999W');
    expect(references(external)).toContain('https://openlibrary.org/works/OL999999W');
    expect(external.statement!.value).toEqual({ type: 'value', content: 'OL999999W' });
    expect((await d.effects()).subjects).toBe(2);
  }));
test('identical dumps after importer restart have zero duplicate effects for every source', () =>
  scenario(async (d) => {
    for (const source of Object.keys(files) as Source[]) {
      const { input, view } = await launch(d, source);
      const effects = await d.effects(),
        baseline = await d.baseline(source);
      await d.restart();
      expect((await d.run(input)).outcome).toBe('complete');
      expect(await d.effects()).toEqual(effects);
      expect(await d.baseline(source)).toEqual(baseline);
      // Changing only the fixture label cannot advance the persisted pointer.
      expect((await d.run({ ...input, snapshot: 'another-fixture-label' })).outcome).toBe('complete');
      expect(await d.baseline(source)).toEqual(baseline);
      expect(await d.effects()).toEqual(effects);
      const after = await d.read(source, keys[source]);
      retrieved(after);
      expect(stored(after)).toEqual(stored(view));
    }
  }));
test('changed records and converter revisions append proposals while community adoption survives', () =>
  scenario(async (d) => {
    const { input, view } = await launch(d, 'openlibrary');
    await d.adopt('openlibrary', keys.openlibrary, d.properties.title, 'Community title');
    const adoptedView = await d.read('openlibrary', keys.openlibrary);
    const before = await d.effects(),
      baseline = await d.baseline(input.source);
    const changed = {
      ...input,
      snapshot: '2020-01-02',
      bytes: encoder.encode(
        new TextDecoder()
          .decode(input.bytes)
          .replaceAll('A Catalogue Journey', 'Revised catalogue')
          .replace('"revision":1', '"revision":2')
          .replace('/works/OL1W\t1\t', '/works/OL1W\t2\t'),
      ),
    };
    expect((await d.run(changed)).outcome).toBe('complete');
    const changedBaseline = await completedBaseline(d, input.source, 2, baseline.snapshot);
    const next = await d.read('openlibrary', keys.openlibrary);
    retrieved(next);
    const old = field(view, d.properties.title, 'A Catalogue Journey');
    const fresh = field(next, d.properties.title, 'Revised catalogue');
    expect(fresh.id).not.toBe(old.id);
    expect(next.retracted).toContain(old.id);
    expect(next.retracted).not.toContain(fresh.id);
    expect(next.subject!.id).toBe(view.subject!.id);
    expect(next.subject!.labels).toEqual(view.subject!.labels);
    expect(fresh.recordDigest).not.toBe(old.recordDigest);
    expect(fresh.recordRevision).toBe('2');
    expect(references(fresh)).toContain(urls.openlibrary);
    expect(next.proposals).toEqual(expect.arrayContaining(view.proposals));
    expect(next.revisions).toEqual(expect.arrayContaining(adoptedView.revisions));
    expect(next.adopted[d.properties.title]).toBe('Community title');
    expect((await d.effects()).subjects).toBe(before.subjects);
    expect((await d.effects()).proposals - before.proposals).toBe(next.proposals.length - view.proposals.length);
    expect((await d.effects()).revisions - before.revisions).toBe(next.revisions.length - adoptedView.revisions.length);
    const effects = await d.effects();
    const secondBefore = await d.read('openlibrary', '/works/OL2W');
    await d.restart();
    expect((await d.run({ ...changed, converterRevision: 'conversion-v2' })).outcome).toBe('complete');
    await completedBaseline(d, input.source, 2, changedBaseline.snapshot);
    const reconverted = await d.read('openlibrary', keys.openlibrary);
    retrieved(reconverted);
    const newVersion = reconverted.proposals.filter((p) => p.converterRevision === 'conversion-v2');
    expect(newVersion.length).toBeGreaterThan(0);
    for (const p of newVersion) {
      expect(p.recordDigest).toBe(fresh.recordDigest);
      expect(p.recordRevision).toBe('2');
    }
    expect(reconverted.proposals).toEqual(expect.arrayContaining(next.proposals));
    expect(reconverted.revisions).toEqual(expect.arrayContaining(next.revisions));
    expect(reconverted.adopted[d.properties.title]).toBe('Community title');
    expect((await d.effects()).proposals).toBeGreaterThan(effects.proposals);
    const secondAfter = await d.read('openlibrary', '/works/OL2W');
    expect((await d.effects()).proposals - effects.proposals).toBe(
      reconverted.proposals.length -
        next.proposals.length +
        secondAfter.proposals.length -
        secondBefore.proposals.length,
    );
    expect((await d.effects()).subjects).toBe(effects.subjects);
  }));
test('mass disappearance stops before bulk writes or checkpoints and isolates sources', () =>
  scenario(async (d) => {
    await d.run(await catalogue(5));
    const other = await dump('vndb');
    await d.run(other);
    const baseline = await d.baseline('bangumi'),
      effects = await d.effects();
    const retained = await d.read('bangumi', '1'),
      otherBaseline = await d.baseline('vndb');
    const run = await d.run(await catalogue(3, true));
    expect(run.outcome).toBe('mass-disappearance');
    expect(run.exchanges).toEqual([]);
    expect(await d.baseline('bangumi')).toEqual(baseline);
    expect(await d.baseline('vndb')).toEqual(otherBaseline);
    expect(await d.effects()).toEqual(effects);
    expect(stored(await d.read('bangumi', '1'))).toEqual(stored(retained));
    expect((await d.run({ ...other, converterRevision: 'conversion-v2' })).outcome).toBe('complete');
  }));
test('exactly twenty percent disappearance proposes source removal without deleting subjects', () =>
  scenario(async (d) => {
    await d.run(await catalogue(5));
    const removed = await d.read('bangumi', '5');
    await d.adopt('bangumi', '5', d.properties.title, 'Retained community title');
    const before = await d.effects(),
      baseline = await d.baseline('bangumi');
    const run = await d.run({ ...(await catalogue(4)), snapshot: '2020-01-02' });
    expect(run.outcome).toBe('complete');
    expect(run.vanished).toEqual(['5']);
    const view = await d.read('bangumi', '5');
    retrieved(view);
    expect(view.subject!.id).toBe(removed.subject!.id);
    expect(view.adopted[d.properties.title]).toBe('Retained community title');
    expect(view.proposals).toEqual(expect.arrayContaining(removed.proposals));
    const proposals = view.proposals.filter((p) => p.kind === 'source-removal');
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p).toMatchObject({ source: 'bangumi', externalId: '5' });
      expect(references(p)).toContain('https://bgm.tv/subject/5');
      expect(p.recordRevision.length).toBeGreaterThan(0);
    }
    const after = await d.effects();
    expect(after.subjects).toBe(before.subjects);
    expect(after.proposals - before.proposals).toBe(proposals.length);
    expect(after.revisions - before.revisions).toBeGreaterThan(0);
    await completedBaseline(d, 'bangumi', 4, baseline.snapshot);
    // Also exercise a permitted disappearance strictly below the threshold.
    expect((await d.run(await catalogue(10))).outcome).toBe('complete');
    const smallBefore = await d.effects(),
      smallBaseline = await d.baseline('bangumi');
    const small = await d.run({ ...(await catalogue(9)), snapshot: '2020-01-03' });
    expect(small.outcome).toBe('complete');
    expect(small.vanished).toEqual(['10']);
    await completedBaseline(d, 'bangumi', 9, smallBaseline.snapshot);
    const smallView = await d.read('bangumi', '10');
    retrieved(smallView);
    expect(smallView.subject).not.toBeNull();
    expect(smallView.proposals.some((p) => p.kind === 'source-removal')).toBe(true);
    expect((await d.effects()).subjects).toBe(smallBefore.subjects);
  }));
test('losing all prior records always stops even for a one-record baseline', () =>
  scenario(async (d) => {
    await d.run(await catalogue(1));
    const before = await d.effects(),
      baseline = await d.baseline('bangumi');
    const run = await d.run(await catalogue(0));
    expect(run.outcome).toBe('mass-disappearance');
    expect(run.exchanges).toEqual([]);
    expect(await d.effects()).toEqual(before);
    expect(await d.baseline('bangumi')).toEqual(baseline);
  }));
test('takedown fences survive unchanged refresh payload changes restart and reconversion', () =>
  scenario(async (d) => {
    const { input, view } = await launch(d, 'bangumi');
    await launch(d, 'vndb');
    const summary = await summaryField(d, view, 'A traveller builds a catalogue.');
    await d.takedown('bangumi', '1', summary.fieldGroup);
    const postTakedown = await d.read('bangumi', '1');
    expect(postTakedown.proposals.some((p) => p.id === summary.id)).toBe(false);
    let effects = await d.effects();
    for (const mode of ['unchanged', 'changed', 'restart', 'converter']) {
      if (mode === 'restart') await d.restart();
      const bytes = encoder.encode(
        new TextDecoder()
          .decode(input.bytes)
          .replace('A traveller builds a catalogue.', 'Forbidden return.')
          .replace('A Catalogue Journey', 'Updated adjacent title')
          .replace('A second catalogue.', 'Updated adjacent record.'),
      );
      expect(
        (
          await d.run({
            ...input,
            bytes: mode === 'unchanged' ? input.bytes : bytes,
            converterRevision: mode === 'converter' ? 'conversion-v2' : input.converterRevision,
          })
        ).outcome,
      ).toBe('complete');
      const after = await d.read('bangumi', '1');
      retrieved(after);
      expect(after.proposals.filter((p) => p.fieldGroup === summary.fieldGroup)).toEqual([]);
      expect(JSON.stringify(after.responses)).not.toContain('Forbidden return.');
      if (mode !== 'unchanged') field(after, d.properties.title, 'Updated adjacent title');
      if (mode === 'converter') {
        expect(
          after.proposals.some(
            (p) => p.statement?.property.id === d.properties.title && p.converterRevision === 'conversion-v2',
          ),
        ).toBe(true);
        expect(
          after.proposals.some(
            (p) => p.statement?.property.id === d.properties.cover && p.converterRevision === 'conversion-v2',
          ),
        ).toBe(true);
      }
      if (mode === 'unchanged') expect(await d.effects()).toEqual(effects);
      effects = await d.effects();
    }
    field(await d.read('bangumi', '1'), d.properties.title, 'A Catalogue Journey');
    await summaryField(d, await d.read('bangumi', '2'), 'Updated adjacent record.');
    expect((await d.run({ ...(await dump('vndb')), converterRevision: 'conversion-v2' })).outcome).toBe('complete');
    const other = await d.read('vndb', 'v1');
    field(other, d.properties.title, 'A Catalogue Journey');
    expect(other.proposals.some((p) => p.converterRevision === 'conversion-v2')).toBe(true);
  }));
test('server fence recheck blocks a takedown arriving after client preflight', () =>
  scenario(async (d) => {
    const { input, view } = await launch(d, 'bangumi');
    const summary = await summaryField(d, view, 'A traveller builds a catalogue.');
    let reached = 0;
    const run = await d.run(
      { ...input, converterRevision: 'conversion-v2' },
      {
        beforeWrite: async () => {
          reached++;
          await d.takedown('bangumi', '1', summary.fieldGroup);
        },
      },
    );
    expect(reached).toBeGreaterThan(0);
    expect(run.exchanges.length).toBeGreaterThan(0);
    const after = await d.read('bangumi', '1');
    expect(after.proposals.filter((p) => p.fieldGroup === summary.fieldGroup)).toEqual([]);
    field(after, d.properties.title, 'A Catalogue Journey');
  }));
test('cover fences prevent reimport on unchanged and changed refresh and hide later disclosures', () =>
  scenario(async (d) => {
    const { input, view } = await launch(d, 'bangumi');
    const cover = view.proposals.find((p) => p.statement?.property.id === d.properties.cover)!;
    await coverField(d, cover);
    const summary = await summaryField(d, view, 'A traveller builds a catalogue.');
    const denied = await d.fence('bangumi', '1', cover.fieldGroup, 'anonymous');
    expect([401, 403]).toContain(denied.status);
    expect((await d.fence('bangumi', '1', cover.fieldGroup, 'ordinary')).status).toBe(403);
    const initial = await d.fence('bangumi', '1', cover.fieldGroup, 'bulk');
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ fenced: false, securityRevision: null });
    await d.takedown('bangumi', '1', cover.fieldGroup);
    const fenced = await d.fence('bangumi', '1', cover.fieldGroup, 'bulk');
    expect(fenced.status).toBe(200);
    expect(fenced.body.fenced).toBe(true);
    expect(fenced.body.securityRevision).toMatch(/^[1-9][0-9]*$/);
    expect(fenced.body.securityRevision).not.toEqual(initial.body.securityRevision);
    // No refresh is needed for final disclosure to observe a later fence.
    expect((await d.disclose(cover)).status).toBe(404);
    expect((await d.disclose(summary)).status).toBe(200);
    const imports = await d.mediaImports();
    expect(imports.requests).toBeGreaterThan(0);
    expect(imports.jobs).toBeGreaterThan(0);
    for (const changed of [false, true]) {
      const bytes = changed
        ? encoder.encode(
            new TextDecoder()
              .decode(input.bytes)
              .replaceAll('cover.jpg', 'replacement.jpg')
              .replace('A Catalogue Journey', 'Adjacent cover title'),
          )
        : input.bytes;
      expect((await d.run({ ...input, bytes })).outcome).toBe('complete');
      expect(await d.mediaImports()).toEqual(imports);
      const after = await d.read('bangumi', '1');
      expect(after.proposals.filter((p) => p.fieldGroup === cover.fieldGroup)).toEqual([]);
      expect((await d.disclose(cover)).status).toBe(404);
      await summaryField(d, after, 'A traveller builds a catalogue.');
      if (changed) field(after, d.properties.title, 'Adjacent cover title');
    }
    await d.takedown('bangumi', '1', summary.fieldGroup);
    const hidden = await d.disclose(summary);
    expect(hidden.status).toBe(404);
    expect(new TextDecoder().decode(hidden.bytes)).not.toContain('A traveller builds a catalogue.');
  }));
test('ordinary preflight and public bulk replays deny import authority before receipt disclosure', () =>
  scenario(async (d) => {
    const input = await dump('openlibrary'),
      empty = await d.effects();
    const denied = await d.run(input, { as: 'ordinary' });
    expect(denied.outcome).toBe('denied');
    // Restricted fence preflight may deny before any public bulk POST.
    for (const x of denied.exchanges) {
      wireCommands(x);
      expect(x.response.status).toBe(403);
      expect(x.receipts).toEqual([]);
      for (const key of x.request.keys) expect(await d.acknowledged(key)).toBe(false);
    }
    expect(await d.effects()).toEqual(empty);
    expect(await d.baseline(input.source)).toMatchObject({ snapshot: null, records: 0 });
    const allowed = await d.run(input);
    expect(allowed.outcome).toBe('complete');
    expect(allowed.exchanges.length).toBeGreaterThan(0);
    const before = await d.effects(),
      baseline = await d.baseline(input.source);
    for (const exchange of allowed.exchanges) await commandReceipts(d, exchange);
    const view = await d.read(input.source, '/works/OL1W');
    expect((await d.fence(input.source, '/works/OL1W', view.proposals[0]!.fieldGroup, 'ordinary')).status).toBe(403);
    for (const as of ['ordinary', 'bulk'] as const) {
      if (as === 'bulk') await d.setBulkPermission(false);
      for (const committed of allowed.exchanges) {
        const replay = await d.replay(committed, as === 'ordinary' ? { as } : undefined);
        expect(replay.status).toBe(403);
        expect(replay.body).not.toEqual(committed.response.body);
        const serialized = JSON.stringify(replay.body);
        for (const id of ['/works/OL1W', '/works/OL2W']) {
          const view = await d.read(input.source, id);
          expect(serialized).not.toContain(view.subject!.id);
          for (const p of view.proposals) expect(serialized).not.toContain(p.id);
        }
        for (const receipt of committed.receipts) {
          expect(serialized).not.toContain(receipt.key);
          expect(serialized).not.toContain(receipt.identity!);
        }
        expect(await d.effects()).toEqual(before);
        expect(await d.baseline(input.source)).toEqual(baseline);
      }
    }
  }));
test('importer obeys actual Retry-After and never acknowledges a rejected batch', () =>
  scenario(async (d) => {
    await d.rateLimit({ requests: 1, windowMs: 1000, nowMs: Date.parse('2020-01-01T00:00:00Z') });
    const baseline = await d.baseline('bangumi');
    let rejected = 0;
    const run = await d.run(await catalogue(17), {
      onRateLimited: async (x) => {
        rejected++;
        expect(x.response.status).toBe(429);
        wireCommands(x);
        expect(x.receipts).toEqual([]);
        expect(x.response.headers.get('retry-after')).not.toBeNull();
        for (const key of x.request.keys) {
          expect(await d.acknowledged(key)).toBe(false);
          expect(await d.receipt(key)).toBeNull();
        }
        expect(await d.baseline('bangumi')).toEqual(baseline);
      },
    });
    expect(run.outcome).toBe('complete');
    expect(rejected).toBeGreaterThan(0);
    for (let i = 0; i < run.exchanges.length; i++) {
      const x = run.exchanges[i]!;
      if (x.response.status !== 429) continue;
      const retry = run.exchanges
        .slice(i + 1)
        .find((next) => JSON.stringify(next.request.keys) === JSON.stringify(x.request.keys))!;
      expect(retry).toBeDefined();
      expect(retry.request.keys).toEqual(x.request.keys);
      expect(retry.request.body).toEqual(x.request.body);
      expect(retry.request.serializedBody).toBe(x.request.serializedBody);
      const raw = x.response.headers.get('retry-after')!;
      const delay = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - x.atMs;
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
      expect(retry.atMs - x.atMs).toBeGreaterThanOrEqual(delay);
      expect(run.waits.some((w) => w.startedAtMs >= x.atMs && w.durationMs >= delay)).toBe(true);
    }
    expect((await d.effects()).subjects).toBe(17);
    const proposals = (
      await Promise.all(Array.from({ length: 17 }, (_, i) => d.read('bangumi', String(i + 1))))
    ).flatMap((view) => view.proposals);
    expect(new Set(proposals.map((p) => p.id)).size).toBe(proposals.length);
    expect((await d.effects()).proposals).toBe(proposals.length);
    expect(run.exchanges.filter((x) => x.response.status === 429).length).toBe(rejected);
    await completedBaseline(d, 'bangumi', 17, baseline.snapshot);
    for (const x of run.exchanges) {
      if (x.response.status === 429) continue;
      await commandReceipts(d, x);
      for (const key of x.request.keys) expect(await d.acknowledged(key)).toBe(true);
    }
  }));
test('transport uncertainty retries stable keys after restart without duplicate effects', () =>
  scenario(async (d) => {
    const input = await dump('wikidata');
    const before = await d.effects(),
      baseline = await d.baseline(input.source);
    const interrupted = await d.run(input, { loseCommittedResponse: true });
    expect(interrupted.outcome).toBe('interrupted');
    const committed = interrupted.exchanges[0]!;
    expect(committed.response.status).toBeGreaterThanOrEqual(200);
    expect(committed.response.status).toBeLessThan(300);
    const creates = wireCommands(committed);
    expect(creates.every((command) => command.op === 'create')).toBe(true);
    await commandReceipts(d, committed);
    expect(await d.baseline(input.source)).toEqual(baseline);
    for (const command of creates) {
      expect(await d.acknowledged(command.key)).toBe(false);
      expect(await d.recordAcknowledged(input.source, command.source.external_id)).toBe(false);
    }
    const effects = await d.effects();
    expect(effects.subjects - before.subjects).toBeGreaterThan(0);
    // Replay at the actual transport boundary before letting the importer proceed.
    const replay = await d.replay(committed);
    expect(replay.status).toBe(committed.response.status);
    expect(replay.body).toEqual(committed.response.body);
    await commandReceipts(d, committed);
    expect(await d.effects()).toEqual(effects);
    for (const command of creates) {
      expect(await d.acknowledged(command.key)).toBe(false);
      expect(await d.recordAcknowledged(input.source, command.source.external_id)).toBe(false);
    }
    expect(await d.baseline(input.source)).toEqual(baseline);
    await d.restart();
    const retry = await d.run(input);
    expect(retry.outcome).toBe('complete');
    expect(retry.exchanges[0]!.request.keys).toEqual(committed.request.keys);
    expect(retry.exchanges[0]!.request.body).toEqual(committed.request.body);
    expect(retry.exchanges[0]!.request.serializedBody).toBe(committed.request.serializedBody);
    expect(retry.exchanges[0]!.response.body).toEqual(committed.response.body);
    expect(retry.exchanges[0]!.receipts).toEqual(committed.receipts);
    const unique = new Map<string, BatchCommand>();
    const identities = new Set<string>();
    for (const x of [...interrupted.exchanges, ...retry.exchanges]) {
      await commandReceipts(d, x);
      for (const command of wireCommands(x)) {
        if (unique.has(command.key)) expect(command).toEqual(unique.get(command.key)!);
        unique.set(command.key, command);
        expect(await d.acknowledged(command.key)).toBe(true);
        identities.add((await d.receipt(command.key))!);
      }
    }
    expect(identities.size).toBe(unique.size);
    const final = await d.effects();
    expect(final.receipts - before.receipts).toBe(unique.size);
    expect(final.subjects - before.subjects).toBe(2);
    expect([...unique.values()].filter((c) => c.op === 'create').length).toBe(2);
    const views = await Promise.all(['Q1', 'Q2'].map((id) => d.read(input.source, id)));
    expect(new Set(views.map((view) => view.subject!.id)).size).toBe(2);
    const proposals = views.flatMap((view) => view.proposals);
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    expect(new Set(proposals.map((p) => p.id)).size).toBe(proposals.length);
    expect(final.proposals - before.proposals).toBe(proposals.length);
    expect([...unique.values()].filter((c) => c.op === 'propose').length).toBe(proposals.length);
    for (const command of unique.values()) {
      const exchange = retry.exchanges.find((x) => x.request.keys.includes(command.key))!;
      const result = (exchange.response.body as unknown as BatchWriteResult).results.find(
        (r) => r.key === command.key,
      )!;
      expect('value' in result).toBe(true);
      if (!('value' in result)) throw new Error('Missing actual command effect');
      const view = await d.read(input.source, command.source.external_id);
      retrieved(view);
      if (command.op === 'create') {
        if (!('id' in result.value)) throw new Error('Missing actual create ID');
        expect(view.subject!.id).toBe(result.value.id);
        for (const proposal of view.proposals) expect(proposal.subjectId).toBe(result.value.id);
      } else {
        expect(command.op).toBe('propose');
        if (!('candidate' in result.value)) throw new Error('Missing actual proposal ID');
        expect(command.subject).toBe(view.subject!.id);
        expect(view.proposals.map((p) => p.id)).toContain(result.value.candidate);
      }
    }
    for (const id of ['Q1', 'Q2']) expect(await d.recordAcknowledged(input.source, id)).toBe(true);
    await completedBaseline(d, input.source, 2, baseline.snapshot);
  }));
test('malformed and truncated dumps never publish disappearances or advance snapshots', () =>
  scenario(async (d) => {
    for (const source of Object.keys(files) as Source[]) {
      const input = await dump(source);
      expect((await d.run(input)).outcome).toBe('complete');
      const before = await d.effects(),
        baseline = await d.baseline(source),
        view = await d.read(source, keys[source]);
      const text =
        source === 'vndb'
          ? await Bun.file(new URL('./fixtures/imports/api/vndb.sql', import.meta.url)).text()
          : new TextDecoder().decode(input.bytes);
      for (const malformed of [text.slice(0, Math.floor(text.length / 3)), text + '\n{malformed\n']) {
        const invalid = { ...input, snapshot: '2020-01-02', bytes: encoder.encode(malformed) };
        delete invalid.entries;
        const run = await d.run(invalid);
        expect(run.outcome).toBe('invalid-input');
        expect(run.vanished).toEqual([]);
        expect(run.exchanges).toEqual([]);
        expect(await d.effects()).toEqual(before);
        expect(await d.baseline(source)).toEqual(baseline);
        expect(stored(await d.read(source, keys[source]))).toEqual(stored(view));
      }
      await d.restart();
      expect((await d.run(input)).outcome).toBe('complete');
      expect(await d.effects()).toEqual(before);
    }
  }));
test('hostile user posts and oversized records never become imported content', () =>
  scenario(async (d) => {
    const input = await dump('bangumi');
    const records = new TextDecoder()
      .decode(input.bytes)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    records[0].posts = [{ id: 9, content: 'PRIVATE USER POST SENTINEL', user: 'private-user' }];
    records[0].comments = ['PRIVATE USER POST SENTINEL'];
    expect(
      (await d.run({ ...input, bytes: encoder.encode(records.map((r) => JSON.stringify(r)).join('\n') + '\n') }))
        .outcome,
    ).toBe('complete');
    const view = await d.read('bangumi', '1');
    retrieved(view);
    expect(JSON.stringify(view)).not.toContain('PRIVATE USER POST SENTINEL');
    await summaryField(d, view, 'A traveller builds a catalogue.');
    const before = await d.effects(),
      baseline = await d.baseline('bangumi');
    records[0].summary = 'x'.repeat(65537);
    expect(
      (await d.run({ ...input, bytes: encoder.encode(records.map((r) => JSON.stringify(r)).join('\n') + '\n') }))
        .outcome,
    ).toBe('invalid-input');
    expect(await d.effects()).toEqual(before);
    expect(await d.baseline('bangumi')).toEqual(baseline);
  }));

// Returned SQLite rows and exact execution counts cannot prove indexed work alone.
// Validate raw plans at each scale; buffers are unavailable, not zero physical IO.
function indexed(c: Counters) {
  for (const value of [
    c.statements,
    c.rowsReturned,
    c.partitions,
    c.inputBytes,
    c.records,
    c.peakBufferedBytes,
    c.maxPageRecords,
    c.workUnits,
  ]) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(c.maxPageRecords).toBeLessThanOrEqual(8);
  expect(c.partitions).toBeLessThanOrEqual(8);
  expect(c.statements).toBe(c.sqlite.executions.length);
  expect(c.rowsReturned).toBe(c.sqlite.executions.reduce((n, statement) => n + statement.rowsReturned, 0));
  for (const statement of c.sqlite.executions) assertIndexedSqlite(statement, c.sqlite);
  // Per-call constants belong to Cost sections: the importer's for SQLite, and Auth, Access, semantic and content's
  // for PostgreSQL. The callers' growth checks prove both stay bounded as the catalogue and history grow.
  const pg = costOf(c.postgres);
  for (const value of [pg.rows, pg.blocks, pg.statements]) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  const counts = { 'sqlite returned rows': c.rowsReturned, 'sqlite executions': c.statements };
  return validateCountedRun({ read: () => counts }, counts, 1);
}
test('fixed changes have bounded indexed work as unrelated catalogue and history grow independently', async () => {
  for (const dimension of ['catalogueRecords', 'historyRows', 'both'] as const) {
    const samples: Record<'reconcile' | 'api' | 'stop' | 'removal' | 'removalApi', Counters>[] = [];
    for (const scale of [32, 128, 512])
      await scenario(async (d) => {
        await d.seed({
          catalogueRecords: dimension === 'historyRows' ? 32 : scale,
          historyRows: dimension === 'catalogueRecords' ? 32 : scale,
        });
        await d.run(await catalogue(1));
        const before = await d.effects();
        const measured = await d.measure(async () => {
          expect((await d.run(await catalogue(1, true))).outcome).toBe('complete');
        });
        expect((await d.effects()).subjects).toBe(before.subjects);
        expect((await d.effects()).proposals).toBeGreaterThan(before.proposals);
        for (const phase of ['reconcile', 'api'] as const) indexed(measured[phase]);
        expect(measured.reconcile.statements).toBeGreaterThan(0);
        expect(measured.reconcile.rowsReturned).toBeGreaterThan(0);
        expect(costOf(measured.api.postgres).statements).toBeGreaterThan(0);
        expect(costOf(measured.api.postgres).rows).toBeGreaterThan(0);
        expect(costOf(measured.api.postgres).blocks).toBeGreaterThan(0);
        const stop = await d.measure(async () => {
          const run = await d.run(await catalogue(0));
          expect(run.outcome).toBe('mass-disappearance');
          expect(run.exchanges).toEqual([]);
        });
        indexed(stop.reconcile);
        await d.run(await catalogue(5));
        const removal = await d.measure(async () => {
          const run = await d.run({ ...(await catalogue(4)), snapshot: '2020-01-03' });
          expect(run.outcome).toBe('complete');
          expect(run.vanished).toEqual(['5']);
        });
        indexed(removal.reconcile);
        indexed(removal.api);
        samples.push({ ...measured, stop: stop.reconcile, removal: removal.reconcile, removalApi: removal.api });
      });
    for (const phase of ['reconcile', 'api', 'stop', 'removal', 'removalApi'] as const) {
      const scales = [32, 128, 512];
      expect(
        countedViolations(
          {
            read: () => ({}),
            bounds: { 'sqlite returned rows': 'constant', 'sqlite executions': 'constant' },
            slack: {
              'sqlite returned rows': { absolute: 2, relative: 0.1 },
              'sqlite executions': { absolute: 0, relative: 0 },
            },
          },
          samples.map((sample, i) => ({ scale: scales[i]!, counted: countedSample([indexed(sample[phase])]) })),
        ),
      ).toEqual([]);
      assertGrowth(
        samples.map((sample, i) => ({ scale: scales[i]!, cost: costOf(sample[phase].postgres) })),
        { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      );
    }
  }
});
test('shared PostgreSQL harness measures real bounded API Auth Access fences and receipts', () =>
  scenario(async (d) => {
    for (const operation of ['changed', 'stop', 'removal'] as const) {
      const report = await checkGrowth(d.growthDatabase, {
        name: `imports-${operation}`,
        scales: [32, 128, 512],
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (_db, scale) => {
          // d.seed uses shared seed/Population and one deterministic setup at every scale.
          await d.seed({ catalogueRecords: scale, historyRows: scale });
          await d.run(await catalogue(operation === 'removal' ? 5 : 1));
        },
        operation: async () => {
          const run = await d.run(
            await catalogue(operation === 'stop' ? 0 : operation === 'removal' ? 4 : 1, operation === 'changed'),
          );
          expect(run.outcome).toBe(operation === 'stop' ? 'mass-disappearance' : 'complete');
          if (operation === 'stop') expect(run.exchanges).toEqual([]);
          if (operation === 'removal') expect(run.vanished).toEqual(['5']);
        },
        // Stop changes nothing, so the default warm-up repeats it. The others warm the same path and restore the
        // state the measured run expects.
        ...(operation === 'stop'
          ? {}
          : {
              warmup: async () => {
                for (const input of [
                  await catalogue(operation === 'removal' ? 4 : 1, operation === 'changed'),
                  await catalogue(operation === 'removal' ? 5 : 1),
                ])
                  expect((await d.run(input)).outcome).toBe('complete');
              },
            }),
      });
      expect(report.samples).toHaveLength(3);
      if (operation !== 'stop')
        for (const sample of report.samples) {
          expect(sample.cost.statements).toBeGreaterThan(0);
          expect(sample.cost.rows).toBeGreaterThan(0);
          expect(sample.cost.blocks).toBeGreaterThan(0);
        }
    }
  }));
test('a full dump imports end to end through the public API with fixed reader memory and re-imports idempotently', async () => {
  await scenario(async (d) => {
    const count = 32;
    const input = await catalogue(count);
    let run!: Run;
    const measured = await d.measure(async () => {
      run = await d.run(input);
      expect(run.outcome).toBe('complete');
    });
    const reader = measured.reader;
    expect(reader.inputBytes).toBe(input.bytes.byteLength);
    expect(reader.records).toBe(count);
    expect(reader.workUnits).toBeGreaterThan(0);
    expect(reader.workUnits).toBeLessThanOrEqual(32 * input.bytes.byteLength + 64 * count);
    const maxRecordBytes = Math.max(
      ...new TextDecoder()
        .decode(input.bytes)
        .trim()
        .split('\n')
        .map((line) => encoder.encode(line).length),
    );
    expect(reader.peakBufferedBytes).toBeLessThanOrEqual(65536 + 8 * maxRecordBytes);
    expect(reader.maxPageRecords).toBeLessThanOrEqual(8);
    expect(reader.statements).toBe(0);
    expect(reader.rowsReturned).toBe(0);
    expect(reader.sqlite.executions).toEqual([]);
    expect(reader.postgres.statements).toEqual([]);
    expect(reader.postgres.plans).toEqual([]);
    expect(reader.partitions).toBe(0);
    expect(run.conversions).toHaveLength(count);
    expect(measured.converter.statements).toBe(0);
    expect(measured.converter.rowsReturned).toBe(0);
    expect(measured.converter.partitions).toBe(0);
    expect(measured.converter.sqlite.executions).toEqual([]);
    expect(measured.converter.postgres.statements).toEqual([]);
    expect(measured.converter.postgres.plans).toEqual([]);
    expect((await d.effects()).subjects).toBe(count);
    const effects = await d.effects();
    const unchanged = await d.measure(async () => {
      const run = await d.run(input);
      expect(run.outcome).toBe('complete');
      expect(run.exchanges).toEqual([]); // Public writes are for D, not S.
    });
    expect(unchanged.reader.records).toBe(count);
    expect(await d.effects()).toEqual(effects);
  });
});
test('pure conversion scales with bounded fields and rejects the hard field cap without database work', () =>
  scenario(async (d) => {
    const first = JSON.parse(new TextDecoder().decode((await dump('wikidata')).bytes).split('\n')[0]!);
    function record(fields: number) {
      const claim = first.claims.P648[0];
      return {
        ...first,
        claims: {
          ...first.claims,
          P648: Array.from({ length: fields }, (_, i) => ({
            ...claim,
            id: `Q1$01234567-89ab-4cde-8012-${String(i).padStart(12, '0')}`,
            mainsnak: { ...claim.mainsnak, datavalue: { value: `OL${900000 + i}W`, type: 'string' } },
          })),
        },
      };
    }
    const { view } = await launch(d, 'wikidata');
    const context = { subjectId: view.subject!.id };
    const fixture = await d.seed({ catalogueRecords: 512, historyRows: 512 });
    const samples: { input: number; output: number }[] = [];
    // The native 64-statement cap includes the preserved P31 type statement.
    for (const fields of [1, 8, 32, 63, 64, 65]) {
      const input = record(fields),
        bytes = encoder.encode(JSON.stringify(input)).length;
      const measured = await d.measure(async () => {
        if (fields + first.claims.P31.length > 64)
          await expect(d.convert('wikidata', input, 'conversion-v1', context)).rejects.toThrow();
        else {
          const converted = await d.convert('wikidata', input, 'conversion-v1', context);
          expect(converted.raw).toHaveProperty('normalizedRecord');
          expect(converted.raw).toHaveProperty('digest');
          const actual = converted.statements.filter((s) => s.property.id === d.properties.externalId);
          expect(actual.length).toBe(fields);
          for (let i = 0; i < fields; i++) {
            expect(actual.some((s) => s.value.type === 'value' && s.value.content === `OL${900000 + i}W`)).toBe(true);
            expect(JSON.stringify(converted.raw)).toContain(`OL${900000 + i}W`);
          }
          if ([1, 8, 63].includes(fields))
            samples.push({ input: bytes, output: encoder.encode(JSON.stringify(converted.raw)).length });
        }
      });
      for (const c of Object.values(measured)) {
        expect(c.statements).toBe(0);
        expect(c.rowsReturned).toBe(0);
        expect(c.partitions).toBe(0);
        expect(costOf(c.postgres).blocks).toBe(0);
        expect(c.sqlite.executions).toEqual([]);
        expect(c.postgres.statements).toEqual([]);
        expect(c.postgres.plans).toEqual([]);
      }
    }
    // Frozen pure-cost amendment: the complete actual return includes normalized
    // data/hash input. Plain three-sample byte deltas, no intrinsic work model.
    expect(samples).toHaveLength(3);
    const [a, b, c] = samples as [(typeof samples)[number], (typeof samples)[number], (typeof samples)[number]];
    expect(b.input).toBeGreaterThan(a.input);
    expect(c.input).toBeGreaterThan(b.input);
    expect(b.output).toBeGreaterThanOrEqual(a.output);
    expect(c.output).toBeGreaterThanOrEqual(b.output);
    expect((c.output - b.output) * (b.input - a.input)).toBeLessThanOrEqual(
      (b.output - a.output) * (c.input - b.input),
    );
    const fixed = record(1);
    const expected = JSON.stringify((await d.convert('wikidata', fixed, 'conversion-v1', context)).raw);
    expect(expected).toBeDefined();
    let converted = 0;
    const ids = new Set<string>();
    for (const count of [32, 8 * 32, 64 * 32]) {
      const measured = await d.measure(async () => {
        while (converted < count) {
          const input = fixture.unrelatedRecord('wikidata', converted++) as { id: string };
          expect(input.id).toMatch(/^Q[1-9][0-9]*$/);
          expect(input.id).not.toBe(first.id);
          expect(ids.has(input.id)).toBe(false);
          ids.add(input.id);
          const actual = await d.convert('wikidata', input, 'conversion-v1', context);
          expect(actual.raw).toHaveProperty('normalizedRecord');
          expect(actual.raw).toHaveProperty('digest');
          expect(JSON.stringify(actual.raw)).toBeDefined();
        }
        expect(JSON.stringify((await d.convert('wikidata', fixed, 'conversion-v1', context)).raw)).toBe(expected);
      });
      for (const cost of Object.values(measured)) {
        expect(cost.statements).toBe(0);
        expect(cost.rowsReturned).toBe(0);
        expect(cost.partitions).toBe(0);
        expect(cost.sqlite.executions).toEqual([]);
        expect(cost.postgres.statements).toEqual([]);
        expect(cost.postgres.plans).toEqual([]);
        expect(costOf(cost.postgres).blocks).toBe(0);
      }
    }
    const oversized = record(1);
    oversized.labels.en.value = 'x'.repeat(65537);
    const rejected = await d.measure(async () => {
      await expect(d.convert('wikidata', oversized, 'conversion-v1', context)).rejects.toThrow();
    });
    for (const c of Object.values(rejected)) {
      expect(c.statements).toBe(0);
      expect(c.rowsReturned).toBe(0);
      expect(c.sqlite.executions).toEqual([]);
      expect(c.postgres.statements).toEqual([]);
      expect(c.postgres.plans).toEqual([]);
      expect(c.partitions).toBe(0);
    }
  }));
