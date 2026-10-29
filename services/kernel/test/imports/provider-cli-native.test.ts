import { expect, test } from 'bun:test';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import bangumi from '../../../../specs/fixtures/imports/bangumi/subject.json';
import edition from '../../../../specs/fixtures/imports/open-library/edition.json';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { openProviderCli, type Candidate, type ProviderCli } from './provider-cli-native-fixture.ts';

type Member = {
  key: string;
  revision: string;
  type?: string;
  fields?: { property: string; values: unknown[]; sameAs?: string }[];
};
type Feed = {
  source: 'bangumi' | 'openlibrary' | 'wikidata';
  converter: string;
  members: Member[];
  first: string;
  refreshed: string;
  malformed: string;
  truncated: string;
  diminished: string;
  target: string;
  property: string;
  oldValue: unknown;
  newValue: unknown;
  newRevision: string;
  citation(key: string, revision: string): string;
};
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const apiFixture = (name: string) => Bun.file(new URL(`../../../../specs/fixtures/imports/api/${name}`, import.meta.url)).text();
const part = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
function cited(candidate: Candidate, feed: Feed, key: string, revision: string) {
  expect(candidate.source).toMatchObject({
    source: feed.source, external_id: key, field_group: candidate.statement.property.id === 'schema:abstract' ? 'summary' : 'facts',
    record_revision: revision, converter_revision: feed.converter,
  });
  expect(candidate.source.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(candidate.statement.references).toContainEqual(expect.objectContaining({
    parts: expect.arrayContaining([expect.objectContaining(part('schema:url', feed.citation(key, revision)))]),
  }));
}
function commands(run: Awaited<ReturnType<ProviderCli['invoke']>>): BatchCommand[] {
  return run.writes.flatMap((exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands);
}
function committed(run: Awaited<ReturnType<ProviderCli['invoke']>>, counts: string) {
  expect(run.code, JSON.stringify(run)).toBe(0);
  expect(run.stderr).toBe('');
  expect(run.stdout).toBe(`Import complete: ${counts}\n`);
  expect(run.seals).toHaveLength(1);
  expect(run.seals[0]!.complete).toBe(true);
  expect(run.seals[0]!.result.status).toBe('ready');
  for (const exchange of run.captured) expect(exchange.status, exchange.responseBytes).toBe(200);
}

/** The shared assertions execute separately in each independently named native case. */
async function journey(feed: Feed) {
  const cli = await openProviderCli(feed.source, feed.converter);
  try {
    const keys = feed.members.map((member) => member.key);
    const permitted = feed.members.filter((member) => member.type);
    const skipped = feed.members.length - permitted.length;
    const count = keys.length;
    const unchanged = `new=0 changed=0 unchanged=${count} vanished=0 skipped=${skipped}`;
    const first = await cli.invoke(feed.first);
    committed(first, `new=${count} changed=0 unchanged=0 vanished=0 skipped=${skipped}`);
    expect(first.seals[0]!.result).toMatchObject({ supplied: count, prior: 0, seenSurvivors: 0 });
    const initial = cli.inspect(keys);
    expect(initial.active).toBeNull();
    expect(initial.source.count).toBe(count);
    expect(initial.source.generation).toBeString();
    expect(initial.bootstraps).toHaveLength(permitted.length);
    const subjects = new Map<string, string>();
    const retrieved: Candidate[] = [];
    for (const member of feed.members) {
      const local = initial.records.find((row) => row.external_id === member.key)!;
      expect(local.baseline).toMatchObject({
        source: feed.source, recordKey: member.key, recordRevision: member.revision,
        converter_revision: feed.converter, state: 'present',
      });
      expect(local.baseline!.digest).toMatch(/^[a-f0-9]{64}$/);
      const claim = await cli.claim(member.key);
      if (!member.type) {
        expect(claim).toEqual([]);
        expect(local.claim).toBeNull();
        expect(commands(first).filter((command) => command.source.external_id === member.key)).toEqual([]);
        continue;
      }
      expect(claim).toHaveLength(1);
      const id = claim[0]!.subject_id;
      subjects.set(member.key, id);
      expect(local.claim).toEqual({ state: 'bound', subject: id });
      const bootstrap = commands(first).find((command) => command.op === 'create' && command.source.external_id === member.key)!;
      expect(bootstrap).toBeDefined();
      const response = first.writes.flatMap((exchange) => (JSON.parse(exchange.responseBytes) as BatchWriteResult).results)
        .find((entry) => entry.key === bootstrap.key)!;
      expect(response).toMatchObject({ value: { id } });
      const view = await cli.anonymous(id);
      expect(view.subject.id).toBe(id);
      expect(view.subject.type).toBe(member.type);
      for (const field of member.fields ?? []) {
        const candidates = await cli.candidates(id, field.property, field.sameAs);
        expect(candidates.map((candidate) => candidate.statement.value)).toEqual(
          expect.arrayContaining(field.values.map((content) => ({ type: 'value', content }))),
        );
        expect(candidates).toHaveLength(field.values.length);
        for (const candidate of candidates) cited(candidate, feed, member.key, member.revision);
        retrieved.push(...candidates);
      }
    }
    expect(commands(first).filter((command) => command.op === 'create')).toHaveLength(permitted.length);
    for (const command of commands(first)) {
      const member = feed.members.find((member) => member.key === command.source.external_id)!;
      expect(command.source).toMatchObject({ source: feed.source, record_revision: member.revision, converter_revision: feed.converter });
      if (command.source.field_group !== 'summary') expect(command).not.toHaveProperty('rights');
      expect(await cli.receipt(command.key)).toHaveLength(1);
    }
    const id = subjects.get(feed.target)!;
    const selected = retrieved.find((candidate) => candidate.source.external_id === feed.target &&
      candidate.statement.property.id === feed.property && JSON.stringify(candidate.statement.value) === JSON.stringify({ type: 'value', content: feed.oldValue }))!;
    expect(selected).toBeDefined();
    // An actual retrieved candidate is accepted/adopted by the independent native editor.
    await cli.select(id, selected);
    expect((await cli.anonymous(id)).subject.statements[feed.property]!.map((statement) => statement.id)).toEqual([selected.id]);
    const before = await cli.effects();
    expect(before.subjects).toHaveLength(permitted.length);
    expect(before.receipts).toHaveLength(cli.commands.size);
    expect(before.subjects.every((subject) => subject.subject.length === 1 && subject.candidates.length > 0)).toBe(true);
    const repeated = await cli.invoke(feed.first);
    committed(repeated, unchanged);
    expect(repeated.writes).toEqual([]);
    expect(await cli.effects()).toEqual(before);
    expect(cli.inspect(keys).records).toEqual(initial.records);
    expect(cli.inspect(keys).bootstraps).toEqual(initial.bootstraps);

    const refreshed = await cli.invoke(feed.refreshed);
    committed(refreshed, `new=0 changed=1 unchanged=${count - 1} vanished=0 skipped=${skipped}`);
    expect(commands(refreshed).length).toBeGreaterThan(0);
    expect(commands(refreshed).every((command) => command.op !== 'create' && command.source.external_id === feed.target)).toBe(true);
    expect(commands(refreshed).every((command) => command.source.record_revision === feed.newRevision)).toBe(true);
    const freshRows = await cli.candidates(id, feed.property);
    const fresh = freshRows.find((candidate) => JSON.stringify(candidate.statement.value) === JSON.stringify({ type: 'value', content: feed.newValue }))!;
    expect(fresh).toBeDefined();
    expect(fresh.id).not.toBe(selected.id);
    expect(fresh.source.digest).not.toBe(selected.source.digest);
    cited(fresh, feed, feed.target, feed.newRevision);
    const retained = freshRows.find((candidate) => candidate.id === selected.id)!;
    expect(retained.statement).toEqual(selected.statement);
    expect(retained.source).toEqual(selected.source);
    expect(retained.retracted).not.toBeNull();
    expect((await cli.anonymous(id)).subject.statements[feed.property]!.map((statement) => statement.id)).toEqual([selected.id]);
    const baseline = cli.inspect(keys);
    expect(baseline.bootstraps).toEqual(initial.bootstraps);
    expect(baseline.records.map((record) => record.claim)).toEqual(initial.records.map((record) => record.claim));
    const after = await cli.effects();
    expect(after.receipts.length).toBeGreaterThan(before.receipts.length);
    for (const receipt of before.receipts) expect(after.receipts).toContainEqual(receipt);
    for (const command of commands(refreshed)) expect(await cli.receipt(command.key)).toHaveLength(1);
    const bootstrapExchange = first.writes.find((exchange) => commands({ ...first, writes: [exchange] }).some((command) => command.op === 'create'))!;
    const replay = await cli.runtime.replay(new Request(bootstrapExchange.url, {
      method: bootstrapExchange.method, headers: bootstrapExchange.headers, body: bootstrapExchange.bytes,
    }));
    expect(replay.status).toBe(bootstrapExchange.status);
    expect(await replay.text()).toBe(bootstrapExchange.responseBytes);
    expect(await cli.effects()).toEqual(after);
    committed(await cli.invoke(feed.refreshed), unchanged);
    expect(await cli.effects()).toEqual(after);
    expect(await cli.candidates(id, feed.property)).toEqual(freshRows);

    const stopped = [];
    for (const input of [feed.malformed, feed.truncated, feed.diminished]) {
      const run = await cli.invoke(input);
      const disappearance = input === feed.diminished;
      expect(run.code, JSON.stringify(run)).toBe(disappearance ? 3 : 2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain(disappearance ? 'Disappearance threshold exceeded.' : 'Input is incomplete or invalid.');
      expect(run.seals).toHaveLength(1);
      expect(run.seals[0]!.complete).toBe(disappearance);
      expect(run.seals[0]!.result).toMatchObject({
        status: disappearance ? 'mass-disappearance' : 'invalid-input', prior: count,
        supplied: disappearance ? 1 : 0, seenSurvivors: disappearance ? 1 : 0,
      });
      expect(run.writes).toEqual([]);
      expect(run.captured).toEqual([]);
      expect(cli.inspect(keys)).toEqual(baseline);
      expect(await cli.effects()).toEqual(after);
      expect(await cli.candidates(id, feed.property)).toEqual(freshRows);
      expect((await cli.anonymous(id)).subject.statements[feed.property]!.map((statement) => statement.id)).toEqual([selected.id]);
      stopped.push({ code: run.code, consumedBytes: run.consumed, seal: run.seals, publicWrites: run.writes.length });
    }
    const reopened = await cli.invoke(feed.refreshed);
    committed(reopened, unchanged);
    expect(reopened.writes).toEqual([]);
    expect(await cli.effects()).toEqual(after);
    const serialized = JSON.stringify([...cli.commands.values(), retrieved, freshRows]);
    for (const sentinel of ['PRIVATE_TEXT_SENTINEL', 'USER_POST_SENTINEL', 'PRIVATE_ACCOUNT_SENTINEL', 'ACCOUNT_SENTINEL',
      'ACCOUNT_ID_SENTINEL', 'USER_POST_PRIVATE_SENTINEL', 'COMMENT_PRIVATE_SENTINEL', 'REVIEW_PRIVATE_SENTINEL', 'UNKNOWN_PROPERTY_SENTINEL'])
      expect(serialized).not.toContain(sentinel);
    // Raw observations establish this connected journey, not a new growth measurement.
    console.log('scalar CLI native evidence', JSON.stringify({ source: feed.source, converter: feed.converter,
      members: count, subjects: after.subjects.length, receipts: after.receipts.length,
      firstInputBytes: first.consumed, firstSeal: first.seals, peakRetainedBytes: first.peakRetainedBytes, stopped }));
    return { cli, subjects, retrieved, first };
  } catch (error) {
    await cli.close();
    throw error;
  }
}

test('Bangumi account-key CLI imports refreshes reopens and safely stops the native scalar feed', async () => {
  const api = (await apiFixture('bangumi.jsonl')).trim().split('\n').map((line) => JSON.parse(line));
  // Scalar acquisition excludes the separate cover journey. IDs and all remaining fields stay native.
  const { images: _images, ...subject } = structuredClone(bangumi);
  const { images: _apiImages, ...book } = api[0]!;
  book.type = 1;
  const game = { ...api[1], type: 4 };
  const records = [subject, book, game, { id: 3, type: 3 }, { id: 6, type: 6 }];
  const changed = structuredClone(records);
  changed[0]!.name = 'The Clockwork Observatory revised';
  const bytes = lines(records), refresh = lines(changed);
  const feed: Feed = {
    source: 'bangumi', converter: 'bangumi@3', first: bytes, refreshed: refresh,
    malformed: lines([changed[0]]) + '{"id":', truncated: refresh.slice(0, -3), diminished: lines([changed[0]]),
    target: '424242', property: 'schema:name', oldValue: { language: 'und', text: bangumi.name },
    newValue: { language: 'und', text: changed[0]!.name }, newRevision: 'unversioned',
    citation: (key) => `https://bgm.tv/subject/${key}`,
    members: [
      { key: '424242', revision: 'unversioned', type: 'schema:TVSeries', fields: [
        { property: 'schema:name', values: [{ language: 'und', text: bangumi.name }, { language: 'zh', text: bangumi.name_cn }] },
        { property: 'wdt:P5732', values: ['424242'] },
      ] },
      { key: '1', revision: 'unversioned', type: 'schema:Book', fields: [{ property: 'schema:name', values: [{ language: 'und', text: 'A Catalogue Journey' }] }] },
      { key: '2', revision: 'unversioned', type: 'schema:VideoGame', fields: [{ property: 'schema:name', values: [{ language: 'und', text: 'A Second Journey' }] }] },
      { key: '3', revision: 'unversioned' }, { key: '6', revision: 'unversioned' },
    ],
  };
  const outcome = await journey(feed);
  try {
    const id = outcome.subjects.get('424242')!;
    const summaries = await outcome.cli.candidates(id, 'schema:abstract');
    expect(summaries.length).toBeGreaterThan(0);
    for (const candidate of summaries) {
      cited(candidate, feed, '424242', 'unversioned');
      const reference = candidate.statement.value.content as { id?: string; document?: string };
      const documentId = reference.id ?? reference.document!;
      const disclosed = await outcome.cli.editor.http(`/v1/documents/${documentId}`);
      expect(disclosed.status).toBe(200);
      expect(JSON.stringify(disclosed.body)).toContain('SUMMARY_END_SENTINEL');
      const native = await outcome.cli.runtime.database.admin.query<{ rights: unknown }>(
        'SELECT rights FROM content.imported_field WHERE route=$1 AND id=$2',
        [(await import('../../src/route/route.ts')).routeOf(documentId), documentId],
      );
      expect(native.rows[0]!.rights).toEqual({ license: 'CC-BY-SA-3.0', obligations: ['cc:Attribution', 'cc:ShareAlike'],
        attribution: 'Bangumi contributors (https://bgm.tv/subject/424242)' });
    }
  } finally { await outcome.cli.close(); }
}, 600_000);

test('Open Library account-key CLI imports refreshes reopens and safely stops the native scalar feed', async () => {
  const workLine = (await apiFixture('openlibrary.tsv')).trim().split('\n')[0]!;
  const work = JSON.parse(workLine.split('\t')[4]!);
  // Keep the edition's real unresolved work/author keys. OL1W is an independent work,
  // so this scalar replay does not claim the separately tested late-binding journey.
  const records = [work, structuredClone(edition)];
  const tsv = (rows: typeof records) => rows.map((row) => [row.type.key, row.key, row.revision, row.last_modified.value, JSON.stringify(row)].join('\t')).join('\n') + '\n';
  const changed = structuredClone(records);
  changed[1]!.title = 'The Glass Atlas: Revised Pocket Edition';
  changed[1]!.revision = 12;
  const bytes = tsv(records), refresh = tsv(changed);
  const feed: Feed = {
    source: 'openlibrary', converter: 'open-library@3', first: bytes, refreshed: refresh,
    malformed: tsv([changed[1]]) + '/type/edition\tbroken\n', truncated: refresh.slice(0, -3), diminished: tsv([changed[1]]),
    target: edition.key, property: 'schema:name', oldValue: { language: 'und', text: edition.title },
    newValue: { language: 'und', text: changed[1]!.title }, newRevision: '12',
    citation: (key) => `https://openlibrary.org${key}`,
    members: [
      { key: work.key, revision: '1', type: 'schema:Book', fields: [{ property: 'schema:name', values: [{ language: 'und', text: 'A Catalogue Journey' }] }] },
      { key: edition.key, revision: '11', type: 'schema:BookEdition', fields: [
        { property: 'schema:name', values: [{ language: 'und', text: edition.title }] },
        { property: 'schema:isbn', values: ['9780306406157'] },
        { property: 'schema:datePublished', values: [{ time: '+1980-05-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' }] },
      ] },
    ],
  };
  const outcome = await journey(feed);
  try {
    const authors = [...outcome.cli.commands.values()].filter((command) => command.op === 'propose' && command.statement.property.id === 'schema:author');
    expect(authors.length).toBeGreaterThan(0);
    for (const command of authors) {
      if (command.op !== 'propose') throw new Error('Expected author proposal');
      expect(command.statement.value).toEqual({ type: 'somevalue' });
      expect(command.statement.qualifiers).toContainEqual(expect.objectContaining(part('wdt:P648', 'OL900000001A')));
    }
    expect(await outcome.cli.claim('/authors/OL900000001A')).toEqual([]);
    expect(await outcome.cli.claim('/works/OL900000001W')).toEqual([]);
    expect(JSON.stringify([...outcome.cli.commands.values()])).not.toContain(edition.notes.value);
    for (const id of outcome.subjects.values()) expect(await outcome.cli.candidates(id, 'schema:abstract')).toEqual([]);
  } finally { await outcome.cli.close(); }
}, 600_000);

test('Wikidata account-key CLI imports refreshes reopens and safely stops the synthetic native scalar feed', async () => {
  const second = JSON.parse((await apiFixture('wikidata.jsonl')).trim().split('\n')[1]!);
  // Q571 and 24681012 are synthetic fixture identities, never observations of live Q571.
  const record = structuredClone(entity);
  const revised = structuredClone(entity);
  revised.lastrevid = 24681013;
  revised.claims.P856[0]!.mainsnak.datavalue.value = 'https://books.example.org/revised';
  const bytes = lines([record, second]), refresh = lines([revised, second]);
  const feed: Feed = {
    source: 'wikidata', converter: 'wikidata-3', first: bytes, refreshed: refresh,
    malformed: lines([revised]) + '{"type":"item",', truncated: refresh.slice(0, -3), diminished: lines([revised]),
    target: 'Q571', property: 'schema:url', oldValue: 'https://books.example.org/example',
    newValue: 'https://books.example.org/revised', newRevision: '24681013',
    citation: (key, revision) => `https://www.wikidata.org/wiki/${key}?oldid=${revision}`,
    members: [
      { key: 'Q571', revision: '24681012', type: 'schema:Book', fields: [
        { property: 'schema:name', values: [{ language: 'en', text: 'The Example Book' }, { language: 'en-GB', text: 'Example Book' }] },
        { property: 'schema:url', values: ['https://books.example.org/example'] },
        { property: 'schema:datePublished', values: [{ time: '+2001-02-03T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' }] },
      ] },
      { key: 'Q2', revision: '102', type: 'schema:Book', fields: [{ property: 'schema:name', values: [{ language: 'en', text: 'A Second Journey' }] }] },
    ],
  };
  const outcome = await journey(feed);
  try {
    for (const qid of ['Q42', 'Q999999999']) {
      const authors = await outcome.cli.candidates(outcome.subjects.get('Q571')!, 'schema:author', `http://www.wikidata.org/entity/${qid}`);
      expect(authors.length).toBeGreaterThan(0);
      for (const author of authors) {
        expect(author.statement.value).toEqual({ type: 'somevalue' });
        expect(author.statement.qualifiers).toContainEqual(expect.objectContaining(part('schema:sameAs', `http://www.wikidata.org/entity/${qid}`)));
      }
      expect(await outcome.cli.claim(qid)).toEqual([]);
    }
    for (const id of outcome.subjects.values()) expect(await outcome.cli.candidates(id, 'schema:abstract')).toEqual([]);
    expect(JSON.stringify([...outcome.cli.commands.values()])).not.toContain('P999999');
  } finally { await outcome.cli.close(); }
}, 600_000);
