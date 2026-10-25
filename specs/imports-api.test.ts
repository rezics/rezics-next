import { expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Counters, Dump, ImportApiDriver, Proposal, RecordView, Run, Source } from './imports-api-driver';

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
  wikidata: 'https://www.wikidata.org/entity/Q1',
};
const licenses = {
  bangumi: 'https://creativecommons.org/licenses/by-sa/3.0/',
  vndb: 'https://opendatacommons.org/licenses/odbl/1.0/',
  openlibrary: 'https://creativecommons.org/publicdomain/zero/1.0/',
  wikidata: 'https://creativecommons.org/publicdomain/zero/1.0/',
};
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
  return {
    source,
    snapshot: '2020-01-01',
    converterRevision: 'conversion-v1',
    bytes: new Uint8Array(
      await Bun.file(new URL(`./fixtures/imports/api/${files[source]}`, import.meta.url)).arrayBuffer(),
    ),
  };
}
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
    (p) => p.kind === 'value' && p.statement?.property.id === property && content(p) === value,
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
  return { subject: view.subject, proposals: view.proposals, revisions: view.revisions, adopted: view.adopted };
}
async function launch(d: ImportApiDriver, source: Source) {
  const input = await dump(source),
    before = await d.effects();
  let run!: Run;
  const measured = await d.measure(async () => {
    run = await d.run(input);
  });
  for (const phase of ['reader', 'converter'] as const) {
    expect(measured[phase].statements).toBe(0);
    expect(measured[phase].rowsExamined).toBe(0);
    expect(measured[phase].partitions).toBe(0);
    expect(measured[phase].sqliteVmSteps).toBe(0);
    expect(measured[phase].pgBuffers).toBe(0);
  }
  expect(run.outcome).toBe('complete');
  expect(run.exchanges.length).toBeGreaterThan(0);
  for (const x of run.exchanges) {
    expect(x.request.method).toBe('POST');
    expect(x.request.headers.get('authorization')).toMatch(/^Bearer \S+$/);
    expect(x.request.key.length).toBeGreaterThan(0);
    expect(x.response.status).toBeGreaterThanOrEqual(200);
    expect(x.response.status).toBeLessThan(300);
  }
  const view = await d.read(source, keys[source]);
  retrieved(view);
  expect(view.subject).not.toBeNull();
  const title = field(view, d.properties.title, 'A Catalogue Journey');
  for (const p of view.proposals) {
    expect(p).toMatchObject({ source, externalId: keys[source], converterRevision: input.converterRevision });
    expect(p.recordDigest.length).toBeGreaterThan(0);
    expect(p.recordRevision.length).toBeGreaterThan(0);
    expect(p.subjectId).toBe(view.subject!.id);
    expect(references(p)).toContain(urls[source]);
  }
  expect(references(title)).toContain(licenses[source]);
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
  expect(await d.baseline(source)).toMatchObject({ snapshot: input.snapshot, records: 2 });
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
    const summary = field(view, d.properties.summary, 'A traveller builds a catalogue.');
    expect(references(summary)).toContain(licenses.bangumi);
    const cover = field(view, d.properties.cover, 'https://example.org/cover.jpg');
    expect(references(cover)).toContain('Example Studio');
    expect(references(cover)).not.toContain(licenses.bangumi);
  }));
test('VNDB COPY dump preserves permitted factual rights and source references', () =>
  scenario(async (d) => {
    const { view } = await launch(d, 'vndb');
    expect(references(field(view, d.properties.title, 'A Catalogue Journey'))).toContain(
      'https://opendatacommons.org/licenses/dbcl/1.0/',
    );
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
      const effects = await d.effects();
      await d.restart();
      expect((await d.run(input)).outcome).toBe('complete');
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
    const before = await d.effects();
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
    const next = await d.read('openlibrary', keys.openlibrary);
    retrieved(next);
    const old = field(view, d.properties.title, 'A Catalogue Journey');
    const fresh = field(next, d.properties.title, 'Revised catalogue');
    expect(fresh.id).not.toBe(old.id);
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
    const before = await d.effects();
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
    expect(await d.baseline('bangumi')).toMatchObject({ records: 4, snapshot: '2020-01-02' });
    // Also exercise a permitted disappearance strictly below the threshold.
    expect((await d.run(await catalogue(10))).outcome).toBe('complete');
    const smallBefore = await d.effects();
    const small = await d.run({ ...(await catalogue(9)), snapshot: '2020-01-03' });
    expect(small.outcome).toBe('complete');
    expect(small.vanished).toEqual(['10']);
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
    const summary = field(view, d.properties.summary, 'A traveller builds a catalogue.');
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
    field(await d.read('bangumi', '2'), d.properties.summary, 'Updated adjacent record.');
    expect((await d.run({ ...(await dump('vndb')), converterRevision: 'conversion-v2' })).outcome).toBe('complete');
    const other = await d.read('vndb', 'v1');
    field(other, d.properties.title, 'A Catalogue Journey');
    expect(other.proposals.some((p) => p.converterRevision === 'conversion-v2')).toBe(true);
  }));
test('server fence recheck blocks a takedown arriving after client preflight', () =>
  scenario(async (d) => {
    const { input, view } = await launch(d, 'bangumi');
    const summary = field(view, d.properties.summary, 'A traveller builds a catalogue.');
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
test('ordinary actors and revoked bulk replays are denied before receipt disclosure', () =>
  scenario(async (d) => {
    const input = await dump('openlibrary'),
      empty = await d.effects();
    const denied = await d.run(input, { as: 'ordinary' });
    expect(denied.outcome).toBe('denied');
    expect(denied.exchanges.length).toBeGreaterThan(0);
    for (const x of denied.exchanges) expect(x.response.status).toBe(403);
    expect(await d.effects()).toEqual(empty);
    expect(await d.baseline(input.source)).toMatchObject({ snapshot: null, acknowledgedBatches: 0 });
    const allowed = await d.run(input),
      committed = allowed.exchanges[0]!;
    expect(allowed.outcome).toBe('complete');
    const before = await d.effects(),
      baseline = await d.baseline(input.source);
    expect(committed.receiptId).not.toBeNull();
    await d.setBulkPermission(false);
    const replay = await d.replay(committed);
    expect(replay.status).toBe(403);
    expect(replay.body).not.toEqual(committed.response.body);
    const serialized = JSON.stringify(replay.body);
    for (const p of (await d.read(input.source, keys.openlibrary)).proposals) expect(serialized).not.toContain(p.id);
    expect(serialized).not.toContain(committed.request.key);
    expect(serialized).not.toContain(committed.receiptId!);
    expect(await d.effects()).toEqual(before);
    expect(await d.baseline(input.source)).toEqual(baseline);
  }));
test('importer obeys actual Retry-After and never acknowledges a rejected batch', () =>
  scenario(async (d) => {
    await d.rateLimit({ requests: 1, windowMs: 1000, nowMs: Date.parse('2020-01-01T00:00:00Z') });
    let rejected = 0;
    const run = await d.run(await catalogue(17), {
      onRateLimited: async (x) => {
        rejected++;
        expect(x.response.status).toBe(429);
        expect(x.receiptId).toBeNull();
        expect(x.response.headers.get('retry-after')).not.toBeNull();
        expect(await d.acknowledged(x.request.key)).toBe(false);
        expect((await d.baseline('bangumi')).acknowledgedBatches).toBeLessThan(3);
      },
    });
    expect(run.outcome).toBe('complete');
    expect(rejected).toBeGreaterThan(0);
    for (let i = 0; i < run.exchanges.length; i++) {
      const x = run.exchanges[i]!;
      if (x.response.status !== 429) continue;
      const retry = run.exchanges.slice(i + 1).find((next) => next.request.key === x.request.key)!;
      expect(retry).toBeDefined();
      expect(retry.request.body).toEqual(x.request.body);
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
    expect(await d.baseline('bangumi')).toMatchObject({ records: 17, acknowledgedBatches: 3 });
  }));
test('transport uncertainty retries stable keys after restart without duplicate effects', () =>
  scenario(async (d) => {
    const input = await dump('wikidata');
    const interrupted = await d.run(input, { loseCommittedResponse: true });
    expect(interrupted.outcome).toBe('interrupted');
    const committed = interrupted.exchanges[0]!;
    expect(committed.response.status).toBeGreaterThanOrEqual(200);
    expect(committed.response.status).toBeLessThan(300);
    expect((await d.baseline('wikidata')).acknowledgedBatches).toBe(0);
    expect(await d.acknowledged(committed.request.key)).toBe(false);
    const effects = await d.effects();
    expect(effects.proposals).toBeGreaterThan(0);
    await d.restart();
    const retry = await d.run(input);
    expect(retry.outcome).toBe('complete');
    expect(retry.exchanges[0]!.request.key).toBe(committed.request.key);
    expect(retry.exchanges[0]!.request.body).toEqual(committed.request.body);
    expect(retry.exchanges[0]!.response.body).toEqual(committed.response.body);
    expect(await d.effects()).toEqual(effects);
    expect(await d.baseline('wikidata')).toMatchObject({ records: 2, acknowledgedBatches: 1 });
    expect(await d.acknowledged(committed.request.key)).toBe(true);
  }));
test('malformed and truncated dumps never publish disappearances or advance snapshots', () =>
  scenario(async (d) => {
    for (const source of Object.keys(files) as Source[]) {
      const input = await dump(source);
      await d.run(input);
      const before = await d.effects(),
        baseline = await d.baseline(source),
        view = await d.read(source, keys[source]);
      const text = new TextDecoder().decode(input.bytes);
      for (const malformed of [text.slice(0, Math.floor(text.length / 3)), text + '\n{malformed\n']) {
        const run = await d.run({ ...input, snapshot: '2020-01-02', bytes: encoder.encode(malformed) });
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
    field(view, d.properties.summary, 'A traveller builds a catalogue.');
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

// Fixed test configuration: B=8, M<=64, record bytes<=65536. No wall-clock ratios.
// A point operation can visit at most 16 index paths per record. The additive
// constants cover fixed Auth/Access/receipt/fence work; none depend on history.
function indexed(c: Counters, fields: number) {
  for (const value of Object.values(c)) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(c.fullScans).toBe(0);
  expect(c.sqliteFullscanSteps).toBe(0);
  expect(c.maxPageRecords).toBeLessThanOrEqual(8);
  expect(c.partitions).toBeLessThanOrEqual(8);
  expect(c.statements).toBeLessThanOrEqual(64 + 16 * fields);
  expect(c.rowsExamined).toBeLessThanOrEqual(128 + 32 * fields + 16 * 8 * c.indexLevels);
  expect(c.pgRows).toBeLessThanOrEqual(128 + 32 * fields);
  expect(c.pgBuffers).toBeLessThanOrEqual(128 + 32 * fields + 16 * 8 * c.indexLevels);
  expect(c.sqliteVmSteps).toBeLessThanOrEqual(1024 + 256 * fields + 128 * 8 * c.indexLevels);
}
test('fixed changes have bounded indexed work as unrelated catalogue and history grow independently', async () => {
  for (const dimension of ['catalogueRecords', 'historyRows'] as const) {
    const samples: Record<'reconcile' | 'api' | 'stop' | 'removal' | 'removalApi', Counters>[] = [];
    for (const scale of [32, 128, 512])
      await scenario(async (d) => {
        await d.seed({ catalogueRecords: 32, historyRows: 32, [dimension]: scale });
        await d.run(await catalogue(1));
        const before = await d.effects();
        const measured = await d.measure(async () => {
          expect((await d.run(await catalogue(1, true))).outcome).toBe('complete');
        });
        expect((await d.effects()).subjects).toBe(before.subjects);
        expect((await d.effects()).proposals).toBeGreaterThan(before.proposals);
        for (const phase of ['reconcile', 'api'] as const) {
          const c = measured[phase];
          indexed(c, 3);
          expect(c.statements).toBeGreaterThan(0);
          expect(c.rowsExamined).toBeGreaterThan(0);
          expect(c.indexLevels).toBeGreaterThan(0);
        }
        expect(measured.reconcile.sqliteVmSteps).toBeGreaterThan(0);
        expect(measured.api.pgBuffers).toBeGreaterThan(0);
        const stop = await d.measure(async () => {
          const run = await d.run(await catalogue(0));
          expect(run.outcome).toBe('mass-disappearance');
          expect(run.exchanges).toEqual([]);
        });
        indexed(stop.reconcile, 3);
        await d.run(await catalogue(5)); // Setup a fixed permitted one-key disappearance.
        const removal = await d.measure(async () => {
          const run = await d.run({ ...(await catalogue(4)), snapshot: '2020-01-03' });
          expect(run.outcome).toBe('complete');
          expect(run.vanished).toEqual(['5']);
        });
        indexed(removal.reconcile, 3);
        indexed(removal.api, 3);
        samples.push({ ...measured, stop: stop.reconcile, removal: removal.reconcile, removalApi: removal.api });
      });
    for (const phase of ['reconcile', 'api', 'stop', 'removal', 'removalApi'] as const) {
      const base = samples[0]![phase];
      for (const sample of samples.slice(1)) {
        const c = sample[phase];
        const levels = Math.max(0, c.indexLevels - base.indexLevels);
        expect(c.statements).toBeLessThanOrEqual(base.statements);
        expect(c.pgRows).toBeLessThanOrEqual(base.pgRows);
        expect(c.rowsExamined).toBeLessThanOrEqual(base.rowsExamined + 16 * 8 * levels);
        expect(c.pgBuffers).toBeLessThanOrEqual(base.pgBuffers + 16 * 8 * levels);
        expect(c.sqliteVmSteps).toBeLessThanOrEqual(base.sqliteVmSteps + 128 * 8 * levels);
      }
    }
  }
});
test('full dump reading scales with supplied bytes and keeps fixed page memory', async () => {
  for (const count of [32, 128, 512])
    await scenario(async (d) => {
      const input = await catalogue(count);
      const measured = await d.measure(async () => {
        expect((await d.run(input)).outcome).toBe('complete');
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
      expect(reader.rowsExamined).toBe(0);
      expect(reader.partitions).toBe(0);
      expect(measured.converter.records).toBe(count);
      expect(measured.converter.statements).toBe(0);
      expect(measured.converter.rowsExamined).toBe(0);
      expect(measured.converter.peakBufferedBytes).toBeLessThanOrEqual(65536);
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
          P648: Array.from({ length: fields }, (_, i) => ({
            ...claim,
            id: `Q1$01234567-89ab-4cde-8012-${String(i).padStart(12, '0')}`,
            mainsnak: { ...claim.mainsnak, datavalue: { value: `OL${900000 + i}W`, type: 'string' } },
          })),
        },
      };
    }
    await d.seed({ catalogueRecords: 512, historyRows: 512 });
    for (const fields of [1, 8, 32, 65]) {
      const input = record(fields),
        bytes = encoder.encode(JSON.stringify(input)).length;
      const measured = await d.measure(async () => {
        if (fields > 64) await expect(d.convert('wikidata', input, 'conversion-v1')).rejects.toThrow();
        else {
          const converted = await d.convert('wikidata', input, 'conversion-v1');
          const actual = converted.statements.filter((s) => s.property.id === d.properties.externalId);
          expect(actual.length).toBe(fields);
          for (let i = 0; i < fields; i++) {
            expect(actual.some((s) => s.value.content === `OL${900000 + i}W`)).toBe(true);
            expect(JSON.stringify(converted.raw)).toContain(`OL${900000 + i}W`);
          }
        }
      });
      for (const c of Object.values(measured)) {
        expect(c.statements).toBe(0);
        expect(c.rowsExamined).toBe(0);
        expect(c.partitions).toBe(0);
        expect(c.pgBuffers).toBe(0);
        expect(c.sqliteVmSteps).toBe(0);
      }
      expect(measured.converter.records).toBe(1);
      expect(measured.converter.workUnits).toBeGreaterThan(0);
      expect(measured.converter.workUnits).toBeLessThanOrEqual(32 * bytes + 64 * Math.min(fields, 64));
      expect(measured.converter.peakBufferedBytes).toBeLessThanOrEqual(65536);
    }
    const oversized = record(1);
    oversized.labels.en.value = 'x'.repeat(65537);
    const rejected = await d.measure(async () => {
      await expect(d.convert('wikidata', oversized, 'conversion-v1')).rejects.toThrow();
    });
    for (const c of Object.values(rejected)) {
      expect(c.statements).toBe(0);
      expect(c.rowsExamined).toBe(0);
      expect(c.partitions).toBe(0);
    }
  }));
