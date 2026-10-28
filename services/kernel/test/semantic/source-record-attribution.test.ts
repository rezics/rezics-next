import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  attributionFixture,
  cited,
  global,
  metadataKind,
  metadataPath,
  records,
  registeredBangumi,
  source,
  status,
  type AttributionFixture,
  type MetadataCommand,
} from './support/source-record-attribution.ts';

let db: GrowthDatabase;
let f: AttributionFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await attributionFixture(db);
});
afterAll(async () => {
  await db?.close();
});

async function supported(origin = source(), value = 'ja') {
  const created = await f.create(origin);
  const candidate = await f.propose(created.id, origin, cited('schema:inLanguage', value));
  await f.select(created.id, candidate);
  return { ...created, candidate };
}
const sorted = (values: unknown[]) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('distinct metadata effects preserve native bootstrap receipts and source identity while current disclosed provenance supplies sourceRecords', async () => {
  const book = await supported();
  const bootstrap = await f.receipt(book.command.key, 'subject.batch_create', book.origin);
  expect(bootstrap).toHaveLength(1);
  const before = await f.nativeSnapshot(book.id);
  const key = randomUUID();
  const record = registeredBangumi(book.origin.external_id);
  const first = await f.metadata(book.origin, record, null, key);
  expect(status(first, 201)).toEqual({ record, metadata_revision: 1, effect: 'filled' });
  expect(await f.metadata(book.origin, record, null, key)).toEqual(first);
  expect(await f.receipt(key, metadataKind, book.origin)).toHaveLength(1);
  expect(await f.batch(book.command)).toEqual(book.result);
  expect(await f.receipt(book.command.key, 'subject.batch_create', book.origin)).toEqual(bootstrap);
  expect(await f.nativeSnapshot(book.id)).toEqual(before);
  const actual = await f.read(book.id);
  expect(actual.id).toBe(book.id);
  expect(records(actual)).toEqual([record]);
  expect(actual.statements['schema:inLanguage'][0].references).toHaveLength(1);
});

test('trusted configured registration supplies the provider name; unknown aliases stay unknown and registered bootstrap terms supply support', async () => {
  const known = await supported(source(randomUUID(), 'my_configured_alias'));
  const record = await f.filled(known.origin);
  expect(records(await f.read(known.id))).toEqual([record]);
  for (const alias of ['bangumi', 'cc_by_sa', 'unknown_catalogue']) {
    const unknown = await supported(source(randomUUID(), alias));
    expect(records(await f.read(unknown.id))).toEqual([]);
    expect(JSON.stringify(await f.read(unknown.id))).not.toContain('CC-BY-SA-3.0');
  }
  const bootstrapOnly = await f.create();
  const bootstrapRecord = await f.filled(bootstrapOnly.origin);
  expect(records(await f.read(bootstrapOnly.id))).toEqual([bootstrapRecord]);
});

test('native fill, duplicate noEffect, immutable replay, typed conflict and exact metadata CAS have separate revisions', async () => {
  const book = await supported();
  const base = { name: 'Bangumi', url: registeredBangumi(book.origin.external_id).url };
  const initialKey = randomUUID();
  const first = await f.metadata(book.origin, base, null, initialKey);
  status(first, 201);
  const unchanged = await f.stored(book.origin);
  expect(status(await f.metadata(book.origin, base), 200)).toEqual({
    record: base,
    metadata_revision: 1,
    effect: 'noEffect',
  });
  expect(await f.stored(book.origin)).toEqual(unchanged);
  const filled = registeredBangumi(book.origin.external_id);
  expect(status(await f.metadata(book.origin, filled), 200)).toEqual({
    record: filled,
    metadata_revision: 2,
    effect: 'filled',
  });
  const conflict = status(await f.metadata(book.origin, { ...filled, name: 'Different provider' }), 409);
  expect(conflict.type).toEndWith('/source_record_metadata_conflict');
  const corrected = { ...base, name: 'Corrected registered name' };
  expect(status(await f.metadata(book.origin, corrected, 2), 200)).toEqual({
    record: corrected,
    metadata_revision: 3,
    effect: 'corrected',
  });
  status(await f.metadata(book.origin, filled, 2), 409);
  expect(await f.metadata(book.origin, base, null, initialKey)).toEqual(first);
  const receipt = await f.receipt(initialKey);
  const mismatch = status(await f.metadata(book.origin, corrected, null, initialKey), 422);
  expect(mismatch.type).toEndWith('/idempotency_conflict');
  expect(await f.receipt(initialKey)).toEqual(receipt);
  expect(records(await f.read(book.id))).toEqual([corrected]);
  expect(status(await f.metadata(book.origin, corrected, 3), 200).effect).toBe('noEffect');
});

test('concurrent native fills and CAS corrections serialize without lost metadata', async () => {
  const origin = source();
  const a = registeredBangumi(origin.external_id);
  const b = { ...a, name: 'Conflicting provider' };
  const fills = await Promise.all([f.metadata(origin, a), f.metadata(origin, b)]);
  expect(fills.map((r) => r.status).sort()).toEqual([201, 409]);
  const winner = fills.find((r) => r.status === 201)!.body.record;
  const corrections = await Promise.all([
    f.metadata(origin, { ...winner, attribution: 'Correction A' }, 1),
    f.metadata(origin, { ...winner, attribution: 'Correction B' }, 1),
  ]);
  expect(corrections.map((r) => r.status).sort()).toEqual([200, 409]);
  const compatible = source();
  const bare = { name: a.name, url: a.url };
  status(await f.metadata(compatible, bare), 201);
  const additions = await Promise.all([
    f.metadata(compatible, { ...bare, licence: { id: 'CC-BY-SA-3.0' } }),
    f.metadata(compatible, { ...bare, attribution: 'Registered contributors' }),
  ]);
  expect(additions.map((r) => r.status)).toEqual([200, 200]);
  const final = status(
    await f.metadata(compatible, { ...bare, licence: a.licence!, attribution: 'Registered contributors' }),
    200,
  );
  expect(final.record).toEqual({ ...bare, licence: a.licence!, attribution: 'Registered contributors' });
});

test('real Global bulk grants are required before replay and suspended accounts get account_suspended', async () => {
  const origin = source();
  const metadata = registeredBangumi(origin.external_id);
  const body: MetadataCommand = {
    source: origin.source,
    external_id: origin.external_id,
    metadata,
    expected_metadata_revision: null,
  };
  for (const as of ['ordinary', 'editor'] as const) {
    const key = randomUUID();
    status(await f.call('POST', metadataPath, body, as, key), 403);
    expect(await f.stored(origin)).toEqual([]);
  }
  status(await f.call('POST', metadataPath, body, null), 401);
  const key = randomUUID();
  status(await f.metadata(origin, metadata, null, key), 201);
  await f.real.revoke(global, 'importer', 'subject:batch_write');
  try {
    status(await f.metadata(origin, metadata, null, key), 403);
  } finally {
    await f.real.grant(global, 'importer', 'subject:batch_write');
  }
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(f.accounts.importer),
    f.accounts.importer,
  ]);
  try {
    const denied = status(await f.metadata(origin, metadata, null, key), 403);
    expect(denied.type).toEndWith('/account_suspended');
  } finally {
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(f.accounts.importer),
      f.accounts.importer,
    ]);
  }
  expect(
    f.real.checks.some((check) => check.action === 'subject:batch_write' && check.resource.id === GLOBAL_CONTEXT),
  ).toBe(true);
});

test('invalid closed metadata and identity boundaries cannot write or infer rights', async () => {
  const origin = source();
  const valid = registeredBangumi(origin.external_id);
  // Every invalid call must reach native validation, never count 404/503 as rejection.
  for (const metadata of [
    { ...valid, name: '' },
    { ...valid, name: 'x'.repeat(256) },
    { ...valid, name: '\ud800' },
    { ...valid, name: 'bad\u0000name' },
    { ...valid, url: 'javascript:alert(1)' },
    { ...valid, url: 'https://user:password@example.test/record' },
    { ...valid, licence: { id: 'inferred-from-bgm.tv' } },
    { ...valid, licence: { id: 'MIT', extra: true } },
    { ...valid, attribution: null },
    { ...valid, rights: { license: 'CC-BY-SA-3.0' } },
  ])
    status(await f.metadata(origin, metadata as typeof valid), 422);
  for (const external_id of ['', 'x'.repeat(256), 'line\nbreak'])
    status(await f.metadata({ ...origin, external_id }, valid), 422);
  const unicode = source('字'.repeat(255), 'a'.repeat(32));
  status(await f.metadata(unicode, { ...valid, url: 'https://example.test/records/unicode' }), 201);
  status(await f.metadata({ ...origin, source: 'a'.repeat(33) }, valid), 422);
  expect(await f.stored(origin)).toEqual([]);
});

test('a real receipt fault rolls metadata and bookkeeping back, then the same native request succeeds', async () => {
  const origin = source();
  const record = await f.filled(origin);
  const before = await f.stored(origin);
  const bookkeeping = async () => {
    const receipts = await db.admin.query(
      'SELECT * FROM core.receipt WHERE command_kind=$1 ORDER BY partition_no,principal_id,idempotency_key',
      [metadataKind],
    );
    const basis = await db.admin.query('SELECT count(*)::int AS count FROM editorial.write_basis');
    const outbox = await db.admin.query('SELECT count(*)::int AS count FROM core.outbox');
    return { receipts: receipts.rows, basis: basis.rows, outbox: outbox.rows };
  };
  const bookkeepingBefore = await bookkeeping();
  const key = randomUUID();
  const functionName = `attribution_fault_${randomUUID().replaceAll('-', '')}`;
  // Database fault in the real command transaction, after metadata mutation, before receipt commit.
  await db.admin.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.command_kind='${metadataKind}' AND NEW.idempotency_key='${key}' THEN
      RAISE EXCEPTION 'source record receipt fault'; END IF; RETURN NEW; END $$`);
  await db.admin.query(
    `CREATE TRIGGER ${functionName} BEFORE INSERT ON core.receipt FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
  );
  try {
    status(await f.metadata(origin, { ...record, name: 'Correction after fault' }, 1, key), 500);
    expect(await f.stored(origin)).toEqual(before);
    expect(await f.receipt(key)).toEqual([]);
    expect(await bookkeeping()).toEqual(bookkeepingBefore);
  } finally {
    await db.admin.query(`DROP TRIGGER ${functionName} ON core.receipt`);
    await db.admin.query(`DROP FUNCTION public.${functionName}()`);
  }
  status(await f.metadata(origin, { ...record, name: 'Correction after fault' }, 1, key), 200);
});

test('current bootstrap and selected multi-source support is attributed, through suppression, hide and native retraction', async () => {
  const book = await supported();
  const a = await f.filled(book.origin);
  const other = source();
  const b = await f.filled(other);
  const candidate = await f.propose(book.id, other, cited('schema:inLanguage', 'en'));
  expect(records(await f.read(book.id))).toEqual([a]); // proposed only
  status(
    await f.call('POST', `/v1/subjects/${book.id}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    }),
    200,
  );
  expect(records(await f.read(book.id))).toEqual([a]); // accepted but unselected
  await f.adopt(book.id, [book.candidate, candidate]);
  expect(sorted(records(await f.read(book.id)))).toEqual(sorted([a, b]));
  await f.adopt(book.id, [], 'schema:inLanguage', 'suppress');
  expect(records(await f.read(book.id))).toEqual([a]);
  await f.adopt(book.id, [book.candidate, candidate]);
  status(
    await f.call('POST', `/v1/subjects/${book.id}/candidates/${book.candidate}:hide`, { reason: 'Withheld original' }),
    200,
  );
  expect(records(await f.read(book.id))).toEqual([a, b]);
  const retraction = await f.batch({
    op: 'retract',
    key: randomUUID(),
    subject: book.id,
    candidate,
    source: other,
    references: cited().references,
  });
  expect(retraction.status).toBe(200);
  expect(records(await f.read(book.id))).toEqual([a]);
  status(await f.metadata(other, { ...b, attribution: 'Corrected only' }, 1), 200);
  expect(records(await f.read(book.id))).toEqual([a]);
});

test('actual partial Content tuple fences remove only affected support with ordinary projection paused', async () => {
  const book = await supported();
  const a = await f.filled(book.origin);
  const other = source();
  const b = await f.filled(other);
  const candidate = await f.propose(book.id, other, cited('schema:inLanguage', 'en'));
  status(
    await f.call('POST', `/v1/subjects/${book.id}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    }),
    200,
  );
  await f.adopt(book.id, [book.candidate, candidate]);
  await f.drain(book.id);
  expect(sorted(records(await f.read(book.id)))).toEqual(sorted([a, b]));
  status(
    await f.call('POST', '/v1/sourceFences:takedown', {
      source: book.origin.source,
      externalId: book.origin.external_id,
      fieldGroup: 'facts',
      reason: 'Actual tuple fence',
    }),
    200,
  );
  // No relay or projection is run after revocation.
  expect(records(await f.read(book.id))).toEqual([b]);
  status(await f.metadata(book.origin, { ...a, attribution: 'Metadata cannot undo fence' }, 1), 200);
  expect(records(await f.read(book.id))).toEqual([b]);
});

test('foreign targets and whole-source hides revoke attribution without a projection refresh', async () => {
  const target = status(
    await f.call('POST', '/v1/subjects', { type: 'schema:Person', labels: { en: 'Foreign author' } }),
    201,
  ).subject;
  const book = await f.create();
  const origin = source();
  const candidate = await f.propose(book.id, origin, cited('schema:author', target.id));
  await f.select(book.id, candidate, 'schema:author', target.id);
  const record = await f.filled(origin);
  await f.drain(book.id, target.id);
  expect(records(await f.read(book.id))).toEqual([record]);
  status(await f.call('POST', `/v1/subjects/${target.id}:hide`, { reason: 'Foreign target withheld' }), 200);
  expect(records(await f.read(book.id))).toEqual([]);
  const other = await supported();
  await f.filled(other.origin);
  status(await f.call('POST', `/v1/subjects/${other.id}:hide`, { reason: 'Source withheld' }), 200);
  const hidden = await f.call('GET', `/v1/subjects/${other.id}`, undefined, null);
  status(hidden, 404);
  expect(JSON.stringify(hidden.body)).not.toContain('Bangumi');
});

test('compact and expanded native provenance agree and merged originals retain distinct actual record URLs', async () => {
  const origin = source();
  const created = await f.historical(origin);
  const record = await f.filled(origin);
  expect(records(await f.read(created.id))).toEqual([record]);
  await f.adopt(created.id, [created.candidate]);
  expect(records(await f.read(created.id))).toEqual([record]);
  const second = await supported(source(), 'ja');
  const secondRecord = await f.filled(second.origin);
  const merged = status(await f.call('POST', '/v1/subjects:merge', { subjects: [created.id, second.id] }), 200);
  await f.drain(created.id, second.id, merged.survivor);
  const survivor = await f.read(merged.survivor);
  expect(sorted(records(survivor))).toEqual(sorted([record, secondRecord]));
  expect((await f.call('GET', `/v1/subjects/${merged.redirected}`)).status).toBe(308);
  const hiddenRecord = merged.redirected === created.id ? record : secondRecord;
  status(await f.call('POST', `/v1/subjects/${merged.redirected}:hide`, { reason: 'Original support withheld' }), 200);
  expect(records(await f.read(merged.survivor))).not.toContainEqual(hiddenRecord);
});

test('actual private consent is attributed only to its audience and metadata correction cannot resurrect retraction', async () => {
  const agent = await ensureAccountAgent(db.pool, {
    account: f.accounts.person,
    kind: 'person',
    name: 'Consent owner',
  });
  const origin = source();
  const created = await f.historical(origin, { target: agent.subject.id, account: f.accounts.person });
  const candidate = created.candidate;
  const record = await f.filled(origin);
  await f.drain(created.id, agent.subject.id);
  expect(records(await f.read(created.id, 'person'))).toEqual([record]);
  expect(records(await f.read(created.id))).toEqual([]);
  status(await f.call('POST', `/v1/statements/${candidate}/disclose`, undefined, 'person'), 200);
  await f.drain(created.id, agent.subject.id);
  expect(records(await f.read(created.id))).toEqual([record]);
  status(await f.call('POST', `/v1/statements/${candidate}/retract`, undefined, 'person'), 200);
  status(await f.metadata(origin, { ...record, attribution: 'Metadata after terminal retraction' }, 1), 200);
  expect(records(await f.read(created.id))).toEqual([]);
  expect(records(await f.read(created.id, 'person'))).toEqual([]);
  status(await f.call('POST', `/v1/statements/${candidate}/disclose`, undefined, 'person'), 409);
});

test('portable facts-rights violation and native command-local 400 preserve separately scoped summary and cover rights', async () => {
  const book = await supported();
  const rights = { license: 'CC0-1.0', obligations: [], attribution: 'Summary author' };
  const invalidKey = randomUUID();
  const invalidCommand = {
    op: 'propose' as const,
    key: invalidKey,
    subject: book.id,
    source: book.origin,
    statement: cited(),
    rights,
  };
  expect(checkBatchWrite({ commands: [invalidCommand] }, bundledRelease)).toContainEqual({
    pointer: '/commands/0/rights',
    code: 'unsupported',
  });
  const unchanged = await f.nativeSnapshot(book.id);
  const outboxBefore = (await db.admin.query('SELECT count(*)::int AS count FROM core.outbox')).rows;
  const invalid = await f.batch(invalidCommand);
  expect(invalid.status).toBe(400);
  expect(invalid.problem).toMatchObject({
    code: 'invalid_request',
    errors: [
      {
        pointer: '/commands/0/rights',
        code: 'unsupported',
      },
    ],
  });
  expect(await f.nativeSnapshot(book.id)).toEqual(unchanged);
  expect(await f.receipt(invalidKey, 'subject.batch_propose')).toEqual([]);
  expect((await db.admin.query('SELECT count(*)::int AS count FROM core.outbox')).rows).toEqual(outboxBefore);
  const summarySource = { ...source(), field_group: 'summary' as const };
  const candidate = await f.propose(
    book.id,
    summarySource,
    cited('schema:abstract', { language: 'en', document: fromPlainText('Separately licensed summary') }),
    rights,
  );
  await f.select(book.id, candidate, 'schema:abstract');
  const media = newId(routeOf(book.id)!);
  const credit = {
    rightsHolder: 'Independent artist',
    via: { name: 'Cover archive', url: 'https://images.example.test/' },
    license: 'LicenseRef-unknown',
    obligations: [],
  };
  const coverOrigin = { ...source(), field_group: 'cover' as const };
  await db.admin.query(
    `INSERT INTO content.media
    (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,
     transaction_id,source_url,credit,provenance,width,height,thumbhash,average_color)
    VALUES ($1,$2,$3,$4,$5,'cover','image/jpeg',96,96,$6,'available',$7,$8,$9,$10,$11,12,18,decode('0000000000','hex'),'#112233')`,
    [
      routeOf(book.id),
      media,
      book.id,
      f.accounts.importer,
      randomUUID(),
      'b'.repeat(64),
      `m/${media}/original`,
      randomUUID(),
      'https://images.example.test/record-cover.jpg',
      credit,
      { ...coverOrigin, references: cited().references },
    ],
  );
  const cover = await f.propose(book.id, coverOrigin, cited('schema:image', media));
  await f.select(book.id, cover, 'schema:image');
  const mediaBefore = (
    await db.admin.query('SELECT credit,provenance FROM content.media WHERE route=$1 AND media_id=$2', [
      routeOf(book.id),
      media,
    ])
  ).rows;
  const before = (
    await db.admin.query('SELECT * FROM content.imported_field WHERE subject=$1 ORDER BY revision', [book.id])
  ).rows;
  const record = await f.filled(book.origin);
  expect(records(await f.read(book.id))).toContainEqual(record);
  expect(
    (await db.admin.query('SELECT * FROM content.imported_field WHERE subject=$1 ORDER BY revision', [book.id])).rows,
  ).toEqual(before);
  expect(JSON.stringify(before)).toContain('CC0-1.0');
  expect(
    (
      await db.admin.query('SELECT credit,provenance FROM content.media WHERE route=$1 AND media_id=$2', [
        routeOf(book.id),
        media,
      ])
    ).rows,
  ).toEqual(mediaBefore);
  expect(mediaBefore[0].credit).toEqual(credit);
});

test('display bounds permit more than 32 source tuples across selected slots without attribution truncation', async () => {
  const book = await f.create();
  const candidates: string[] = [];
  const expected = [];
  for (let index = 0; index < 32; index++) {
    const origin = source();
    const language = `a${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    const candidate = await f.propose(book.id, origin, cited('schema:inLanguage', language));
    status(
      await f.call('POST', `/v1/subjects/${book.id}/candidates/${candidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      }),
      200,
    );
    candidates.push(candidate);
    expected.push(await f.filled(origin));
  }
  await f.adopt(book.id, candidates);
  const summaryOrigin = { ...source(), field_group: 'summary' as const };
  const summary = await f.propose(
    book.id,
    summaryOrigin,
    cited('schema:abstract', { language: 'en', document: fromPlainText('Another selected source') }),
    { license: 'CC0-1.0', obligations: [], attribution: 'Summary author' },
  );
  await f.select(book.id, summary, 'schema:abstract');
  expected.push(await f.filled(summaryOrigin));
  const actual = await f.read(book.id);
  expect(actual.statements['schema:inLanguage']).toHaveLength(32);
  expect(sorted(records(actual))).toEqual(sorted(expected));
  expect(records(actual)).toHaveLength(33);
});

test('sourceRecords includes currently disclosed native bootstrap metadata and selected support with exact source fences', async () => {
  const origin = source();
  const a = await f.filled(origin); // Real metadata ACK before any claim.
  const terms = {
    labels: { en: 'Original licensed label' },
    descriptions: { en: 'Original licensed description' },
    aliases: { en: ['Original licensed alias'] },
  };
  const book = await f.create(origin, terms);
  const bootstrap = await f.read(book.id);
  expect(bootstrap.labels).toEqual(terms.labels);
  expect(bootstrap.descriptions).toEqual(terms.descriptions);
  expect(bootstrap.aliases).toEqual(terms.aliases);
  expect(records(bootstrap)).toEqual([a]);
  const original = await f.nativeSnapshot(book.id);
  expect(original.revisions[0].source).toEqual(origin);
  const other = source();
  const b = await f.filled(other);
  const name = await f.propose(book.id, other, cited('schema:name', { language: 'en', text: 'Selected new name' }));
  // An unselected candidate does not disclose B, while the bootstrap term locator still supplies A.
  expect(records(await f.read(book.id))).toEqual([a]);
  await f.select(book.id, name, 'schema:name');
  const selected = await f.read(book.id);
  expect(selected.statements['schema:name'][0].value.content).toEqual({ language: 'en', text: 'Selected new name' });
  expect(selected.labels).toEqual(terms.labels);
  expect(selected.aliases).toEqual(terms.aliases);
  expect(sorted(records(selected))).toEqual(sorted([a, b]));
  await f.adopt(book.id, [], 'schema:name', 'suppress');
  expect(records(await f.read(book.id))).toEqual([a]);
  await f.adopt(book.id, [name], 'schema:name');
  await f.drain(book.id);
  status(
    await f.call('POST', '/v1/sourceFences:takedown', {
      source: origin.source,
      externalId: origin.external_id,
      fieldGroup: 'summary',
      reason: 'Separate field group',
    }),
    200,
  );
  const factsUnaffected = await f.read(book.id);
  expect(sorted(records(factsUnaffected))).toEqual(sorted([a, b]));
  expect(factsUnaffected.labels).toEqual(terms.labels);
  expect(factsUnaffected.descriptions).toEqual(terms.descriptions);
  expect(factsUnaffected.aliases).toEqual(terms.aliases);
  status(
    await f.call('POST', '/v1/sourceFences:takedown', {
      source: origin.source,
      externalId: origin.external_id,
      fieldGroup: 'facts',
      reason: 'Withhold original terms',
    }),
    200,
  );
  // Current Content fences apply to the payload as well as attribution, without a projection refresh.
  const fenced = await f.read(book.id);
  expect(records(fenced)).toEqual([b]);
  expect(fenced.labels).toEqual({});
  expect(fenced.descriptions).toEqual({});
  expect(fenced.aliases).toEqual({});
  expect(JSON.stringify(fenced)).not.toContain('Original licensed');
  expect(fenced.statements['schema:name'][0].value.content.text).toBe('Selected new name');
  expect((await f.nativeSnapshot(book.id)).revisions[0]).toEqual(original.revisions[0]);
});

test('firstparty sealed admitted run commits metadata before bootstrap without mutating old receipts or emitting effects on acquisition failure: native server prerequisites', async () => {
  // This exercises the real server ports only. Importer acquisition/seal/journal binding is NOT YET FROZEN;
  // see the owning contract. Calling these ports in order does not prove first-party run ordering.
  const origin = source();
  const record = registeredBangumi(origin.external_id);
  const key = randomUUID();
  const before = await db.admin.query('SELECT count(*)::int AS count FROM core.outbox');
  const claims = async () =>
    (
      await db.admin.query('SELECT * FROM semantic.external_claim WHERE source=$1 AND external_id=$2', [
        origin.source,
        origin.external_id,
      ])
    ).rows;
  expect(await claims()).toEqual([]);
  status(await f.metadata(origin, { ...record, name: '' }, null, key), 422);
  expect(await claims()).toEqual([]);
  expect(await f.receipt(key)).toEqual([]);
  expect(await db.admin.query('SELECT count(*)::int AS count FROM core.outbox').then((r) => r.rows)).toEqual(
    before.rows,
  );
  const fault = `attribution_preclaim_${randomUUID().replaceAll('-', '')}`;
  await db.admin.query(`CREATE FUNCTION public.${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.command_kind='${metadataKind}' AND NEW.idempotency_key='${key}' THEN
      RAISE EXCEPTION 'preclaim metadata receipt fault'; END IF; RETURN NEW; END $$`);
  await db.admin.query(
    `CREATE TRIGGER ${fault} BEFORE INSERT ON core.receipt FOR EACH ROW EXECUTE FUNCTION public.${fault}()`,
  );
  try {
    status(await f.metadata(origin, record, null, key), 500);
    expect(await f.stored(origin)).toEqual([]);
    expect(await claims()).toEqual([]);
    expect(await f.receipt(key)).toEqual([]);
    expect(await db.admin.query('SELECT count(*)::int AS count FROM core.outbox').then((r) => r.rows)).toEqual(
      before.rows,
    );
  } finally {
    await db.admin.query(`DROP TRIGGER ${fault} ON core.receipt`);
    await db.admin.query(`DROP FUNCTION public.${fault}()`);
  }
  const acknowledged = await f.metadata(origin, record, null, key);
  status(acknowledged, 201);
  expect(await claims()).toEqual([]); // Metadata alone is not a public fact or claim.
  const receipt = await f.receipt(key, metadataKind, origin);
  expect(receipt).toHaveLength(1);
  // Lost metadata ACK: retry the exact body/key before bootstrap, preserving the native receipt.
  expect(await f.metadata(origin, record, null, key)).toEqual(acknowledged);
  expect(await f.receipt(key)).toEqual(receipt);
  const created = await f.create(origin);
  const bytes = JSON.stringify(created.command);
  const bootstrap = await f.receipt(created.command.key, 'subject.batch_create', origin);
  expect(bootstrap).toHaveLength(1);
  expect(records(await f.read(created.id))).toEqual([record]);
  const snapshot = await f.nativeSnapshot(created.id);
  expect(snapshot.revisions[0].source).toEqual(origin);
  expect(await f.batch(created.command)).toEqual(created.result); // Lost bootstrap ACK.
  status(await f.metadata(origin, { ...record, attribution: 'Explicit correction' }, 1), 200);
  expect(await f.metadata(origin, record, null, key)).toEqual(acknowledged);
  expect(await f.batch(created.command)).toEqual(created.result);
  expect(JSON.stringify(created.command)).toBe(bytes);
  expect(await f.receipt(created.command.key, 'subject.batch_create', origin)).toEqual(bootstrap);
  expect(await f.nativeSnapshot(created.id)).toEqual(snapshot);
});

test('reviewed single descriptors survive native metadata serialization and bootstrap reads without expanding their rights scope', async () => {
  // Explicit trusted snapshots are inputs to the same generic HTTP operation, never Core provider branches.
  const descriptors = [
    registeredBangumi('1'),
    {
      name: 'VNDB',
      url: 'https://vndb.org/v1',
      licence: { id: 'LicenseRef-DbCL-1.0', url: 'http://opendatacommons.org/licenses/dbcl/1.0/' },
      attribution:
        'VNDB metadata contents: DbCL-1.0; database rights: ODbL-1.0 http://opendatacommons.org/licenses/odbl/1.0/. Excludes images and creative descriptions; no blanket licence for the output database.',
    },
    {
      name: 'Open Library',
      url: 'https://openlibrary.org/works/OL1W',
      licence: { id: 'CC0-1.0' },
      attribution:
        'Open Library bibliographic metadata only; prose rights unknown; covers and media have separate rights.',
    },
    {
      name: 'Wikidata',
      url: 'https://www.wikidata.org/wiki/Q1',
      licence: { id: 'CC0-1.0' },
      attribution:
        'Wikidata contributors; structured data only; external references, text and images have separate rights.',
    },
  ];
  for (const descriptor of descriptors) {
    const origin = source(randomUUID(), 'explicit_configured_alias');
    await f.filled(origin, descriptor);
    const stored = await f.stored(origin);
    expect(stored[0].record).toEqual(descriptor);
    const created = await f.create(origin);
    expect(records(await f.read(created.id))).toEqual([descriptor]);
    expect((await f.nativeSnapshot(created.id)).revisions[0].source).toEqual(origin);
  }
});
