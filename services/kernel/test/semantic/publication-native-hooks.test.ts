import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from './real-access.ts';
import type { Access } from '../../src/request/access.ts';
import type { PublicationStore } from './subject-page-local-publication.test.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { explainUnresolvedResourceType, resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { contextTarget, createContext, globalContextAnchor } from '../../src/semantic/context.ts';
import readCreatedContext from '../../src/semantic/http/contexts-read-creation.sql';
import { capture, costOf, openGrowthDatabase, seed } from '../support/growth.ts';
import { itemFacts } from '../../src/semantic/item.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
let time = new Date();
const clock = () => time;
const tick = () => (time = new Date(time.getTime() + 1000)).toISOString();
const routeKey = new Uint8Array(32).fill(91);
const real = await createRealAccess(
  admin,
  { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000191' },
  [
    'subject:create',
    'subject:batch_write',
    'subject:read',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
  ],
  { clock },
);
let access: Access;
const app = createKernel({
  pool,
  routeKey,
  clock,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) },
  writeRate: real.writeRate,
  access(config) {
    return (access = real.access(config));
  },
});
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf('019a1b2c-3d4e-7f00-8a00-ed170e000191'),
    '019a1b2c-3d4e-7f00-8a00-ed170e000191',
  ]);
  for (const action of [
    'subject:create',
    'subject:batch_write',
    'subject:read',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
  ])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function post(path: string, body: unknown, status = 200, key = randomUUID()) {
  const send = () =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${key}"`,
        },
        body: JSON.stringify(body),
      }),
    );
  let response = await send();
  let value = (await response.json()) as Record<string, any>;
  for (
    let retry = 0;
    retry < 2 &&
    response.status === 503 &&
    value.code === 'overloaded' &&
    value.retryable &&
    value.effect_status === 'not_applied';
    retry++
  ) {
    response = await send();
    value = (await response.json()) as Record<string, any>;
  }
  expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
  return value;
}
const statement = (content: string) => ({ property: { id: 'schema:inLanguage' }, value: { type: 'value', content } });

test('every native public mutation records only its actual shown component transitions', async () => {
  const createdAt = tick();
  const subject = (
    await post(
      '/v1/subjects',
      { type: 'schema:Book', labels: { en: 'Hook audit' }, statements: { 'schema:inLanguage': [statement('ja')] } },
      201,
    )
  ).subject;
  const path = '../../src/semantic/subject-page-publication-store.ts';
  const module = await import(path).catch(() => ({}));
  expect(typeof (module as any).createSubjectPagePublicationStore).toBe('function');
  const store: PublicationStore = (module as any).createSubjectPagePublicationStore({
    pool,
    access: access!,
    clock,
    routeKey,
  });
  const key = { route: routeOf(subject.id)!, id: subject.id };
  const original = subject.statements['schema:inLanguage'][0].id;
  expect((await store.read(key))?.publicEffectiveAt).toBe(createdAt);
  tick();
  const candidate = (
    await post(
      `/v1/subjects/${subject.id}/candidates`,
      {
        statement: {
          ...statement('en'),
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/audit' } },
              ],
            },
          ],
        },
      },
      201,
    )
  ).candidate;
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect((await store.read(key))?.publicEffectiveAt).toBe(createdAt);
  // A changed selected rank, an empty selection, and replacement are distinct public transitions.
  const rankedAt = tick();
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate: original, rank: 'preferred' }],
    expected_head: 1,
  });
  expect((await store.read(key))?.publicEffectiveAt).toBe(rankedAt);
  const ranked = await store.read(key);
  tick();
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate: original, rank: 'preferred' }],
    expected_head: 2,
  });
  expect(await store.read(key)).toEqual(ranked);
  const removedAt = tick();
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [],
    expected_head: 3,
  });
  expect((await store.read(key))?.publicEffectiveAt).toBe(removedAt);
  expect(await store.readCurrent(key)).toBeNull();
  const replacedAt = tick();
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: 4,
  });
  expect((await store.readCurrent(key))?.lastModified).toBe(replacedAt);
  const hiddenAt = tick();
  const receipt = randomUUID();
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:hide`, { reason: 'Audit hide' }, 200, receipt);
  expect((await store.read(key))?.publicEffectiveAt).toBe(hiddenAt);
  expect(await store.readCurrent(key)).toBeNull();
  const restoredAt = tick();
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:restore`, { reason: 'Audit restore' });
  expect((await store.readCurrent(key))?.lastModified).toBe(restoredAt);
  const restored = await store.read(key);
  tick();
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:hide`, { reason: 'Audit hide' }, 200, receipt);
  expect(await store.read(key)).toEqual(restored);
  const ledger = await admin.query(
    `SELECT change_id, component_kind, component_key, effective_at FROM semantic.subject_page_change
    WHERE route=$1 AND subject_id=$2 ORDER BY position`,
    [key.route, key.id],
  );
  expect(new Set(ledger.rows.map((row) => row.change_id)).size).toBe(ledger.rows.length);
  expect(ledger.rows.filter((row) => row.component_key === original).length).toBe(3);
  expect(ledger.rows.filter((row) => row.component_key === candidate).length).toBe(3);
}, 120_000);

test('moderating an unselected proposal does not create public transitions', async () => {
  tick();
  const subject = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Unselected moderation' },
        statements: { 'schema:inLanguage': [statement('ja')] },
      },
      201,
    )
  ).subject;
  const module = await import('../../src/semantic/subject-page-publication-store.ts');
  const store = module.createSubjectPagePublicationStore({ pool, access: access!, clock, routeKey });
  const key = { route: routeOf(subject.id)!, id: subject.id };
  const before = await store.read(key);
  expect(before?.evidence).toBe('known');
  const candidate = (
    await post(
      `/v1/subjects/${subject.id}/candidates`,
      {
        statement: {
          ...statement('en'),
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: 'https://example.test/unselected' },
                },
              ],
            },
          ],
        },
      },
      201,
    )
  ).candidate;
  tick();
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:hide`, { reason: 'Unselected proposal' });
  expect(await store.read(key)).toEqual(before);
  tick();
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:restore`, { reason: 'Unselected proposal' });
  expect(await store.read(key)).toEqual(before);
  expect((await store.readCurrent(key))?.lastModified).toBe(before?.publicEffectiveAt ?? undefined);
}, 120_000);

test('native agent labels, consent, bulk retraction and verification retain real originating changes', async () => {
  const module = await import('../../src/semantic/subject-page-publication-store.ts');
  const store = module.createSubjectPagePublicationStore({ pool, access: access!, clock, routeKey });
  const account = '019a1b2c-3d4e-7f00-8a00-ed170e000191';
  const blank = await ensureAccountAgent(pool, { account, kind: 'person', name: null });
  const agentKey = { route: routeOf(blank.subject.id)!, id: blank.subject.id };
  expect((await store.read(agentKey))?.publicEffectiveAt).toBeNull();
  expect(await store.readCurrent(agentKey)).toBeNull();
  await ensureAccountAgent(pool, { account, kind: 'person', name: 'Consent owner' });
  const named = await store.read(agentKey);
  expect(named?.evidence).toBe('known');
  expect(named?.publicEffectiveAt).not.toBeNull();
  await ensureAccountAgent(pool, { account, kind: 'person', name: 'Consent owner' });
  expect(await store.read(agentKey)).toEqual(named);
  await ensureAccountAgent(pool, { account, kind: 'person', name: 'Renamed owner', language: 'fr' });
  expect(await store.read(agentKey)).not.toEqual(named);
  const pen = (await post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Pen name' } }, 201)).subject;
  const penKey = { route: routeOf(pen.id)!, id: pen.id };
  const prior = await store.read(penKey);
  const privateCandidate = (
    await post(
      `/v1/subjects/${pen.id}/candidates`,
      {
        statement: {
          property: { id: 'rezics:penNameOf' },
          value: { type: 'value', content: agentKey.id },
          references: [],
        },
      },
      201,
    )
  ).candidate;
  expect(await store.read(penKey)).toEqual(prior);
  expect(await store.readCurrent(penKey)).toBeNull();
  const disclosedAt = tick();
  await post(`/v1/statements/${privateCandidate}/disclose`, {});
  expect((await store.readCurrent(penKey))?.lastModified).toBe(disclosedAt);
  const disclosed = await store.read(penKey);
  tick();
  await post(`/v1/statements/${privateCandidate}/disclose`, {});
  expect(await store.read(penKey)).toEqual(disclosed);
  const retractedAt = tick();
  await post(`/v1/statements/${privateCandidate}/retract`, {});
  expect((await store.read(penKey))?.publicEffectiveAt).toBe(retractedAt);
  expect(await store.readCurrent(penKey)).toBeNull();
  const retracted = await store.read(penKey);
  tick();
  await post(`/v1/statements/${privateCandidate}/retract`, {});
  expect(await store.read(penKey)).toEqual(retracted);

  const book = (await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Imported audit' } }, 201)).subject;
  const bookKey = { route: routeOf(book.id)!, id: book.id };
  const source = {
    source: 'openlibrary',
    external_id: randomUUID(),
    record_revision: '1',
    digest: 'd'.repeat(64),
    converter_revision: 'audit@1',
    field_group: 'facts',
  };
  const references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/import' } }] },
  ];
  const proposed = (
    await post('/v1/subjects:batchWrite', {
      commands: [
        { op: 'propose', key: randomUUID(), source, subject: book.id, statement: { ...statement('ja'), references } },
      ],
    })
  ).results[0];
  expect(proposed.status).toBe(201);
  const imported = proposed.value.candidate;
  await post(`/v1/subjects/${book.id}/candidates/${imported}:accept`, { context: GLOBAL_CONTEXT, expected_head: null });
  tick();
  await post(`/v1/subjects/${book.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate: imported, rank: 'normal' }],
    expected_head: null,
  });
  expect(await store.readCurrent(bookKey)).not.toBeNull();
  const importedAt = tick();
  const retract = {
    op: 'retract',
    key: randomUUID(),
    source: { ...source, record_revision: '2' },
    subject: book.id,
    candidate: imported,
    references,
  };
  const result = (await post('/v1/subjects:batchWrite', { commands: [retract] })).results[0];
  expect(result.status).toBe(200);
  expect((await store.read(bookKey))?.publicEffectiveAt).toBe(importedAt);
  expect(await store.readCurrent(bookKey)).toBeNull();
  const retired = await store.read(bookKey);
  tick();
  expect((await post('/v1/subjects:batchWrite', { commands: [retract] })).results[0].status).toBe(200);
  expect(await store.read(bookKey)).toEqual(retired);

  const catalogue = (await post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Catalogue owner' } }, 201))
    .subject;
  const unknown = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Unknown author' },
        statements: { 'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'somevalue' } }] },
      },
      201,
    )
  ).subject;
  expect(await store.readCurrent({ route: routeOf(unknown.id)!, id: unknown.id })).not.toBeNull();
  const linked = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Moved relation' },
        statements: {
          'schema:author': [
            { property: { id: 'schema:author' }, value: { type: 'value', content: agentKey.id }, references },
          ],
        },
      },
      201,
    )
  ).subject;
  const projection = linkProjection(pool);
  for (let page = 0; page < 4; page++) await projection.run(partitionOf(routeOf(linked.id)!));
  const receipt = randomUUID();
  await verifyAccountAgent(pool, { account, catalogue: catalogue.id, receipt });
  const merged = await store.read(agentKey);
  expect(await store.readCurrent(agentKey)).toBeNull();
  expect(await store.readCurrent({ route: routeOf(linked.id)!, id: linked.id })).not.toBeNull();
  const origin = await admin.query(
    'SELECT change_id, effective_at FROM semantic.subject_page_continuation WHERE route=$1 AND subject_id=$2 AND kind=$3',
    [agentKey.route, agentKey.id, 'merge'],
  );
  expect(origin.rows).toHaveLength(1);
  expect(origin.rows[0].effective_at.toISOString()).toBe(merged?.publicEffectiveAt);
  await verifyAccountAgent(pool, { account, catalogue: catalogue.id, receipt });
  expect(await store.read(agentKey)).toEqual(merged);
  expect(await moveMergePage(pool, agentKey.id, catalogue.id, ['links'], { account, receipt })).toBe(true);
  const moved = await admin.query(
    'SELECT publication_origin FROM semantic.merge_member WHERE route=$1 AND subject_id=$2 AND member_id=$3',
    [routeOf(catalogue.id), catalogue.id, agentKey.id],
  );
  expect(moved.rows[0].publication_origin).toEqual({
    changeId: origin.rows[0].change_id,
    time: { effectiveAt: merged!.publicEffectiveAt, evidence: 'known' },
  });
  const deliveries = await admin.query(
    'SELECT event_id, effective_at FROM semantic.subject_page_delivery WHERE route=$1 AND subject_id=$2 AND change_id=$3',
    [routeOf(catalogue.id), catalogue.id, origin.rows[0].change_id],
  );
  expect(deliveries.rows.length).toBeGreaterThan(0);
  expect(deliveries.rows.every((row) => row.effective_at.toISOString() === merged!.publicEffectiveAt)).toBe(true);
  expect(await moveMergePage(pool, agentKey.id, catalogue.id, ['links'], { account, receipt })).toBe(false);
  expect(
    (
      await admin.query(
        'SELECT event_id FROM semantic.subject_page_delivery WHERE route=$1 AND subject_id=$2 AND change_id=$3',
        [routeOf(catalogue.id), catalogue.id, origin.rows[0].change_id],
      )
    ).rows,
  ).toHaveLength(deliveries.rows.length);
  await unverifyAccountAgent(pool, { account, receipt });
  const reversed = await store.read(agentKey);
  const reverseOrigin = await admin.query(
    'SELECT change_id, effective_at FROM semantic.subject_page_continuation WHERE route=$1 AND subject_id=$2 AND kind=$3',
    [agentKey.route, agentKey.id, 'unverify'],
  );
  expect(reverseOrigin.rows[0].effective_at.toISOString()).toBe(reversed?.publicEffectiveAt);
  await unverifyAccountAgent(pool, { account, receipt });
  expect(await store.read(agentKey)).toEqual(reversed);
}, 120_000);

test('exhausting bounded native witnesses retains honest durable uncertainty', async () => {
  const module = await import('../../src/semantic/subject-page-publication-store.ts');
  const store = module.createSubjectPagePublicationStore({ pool, access: access!, clock, routeKey });
  const created = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Witness overflow' },
        statements: { 'schema:inLanguage': ['en', 'ja', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv'].map(statement) },
      },
      201,
    )
  ).subject;
  const key = { route: routeOf(created.id)!, id: created.id };
  const initial = await store.read(key);
  expect(initial?.witnesses).toHaveLength(8);
  const retained = new Set(initial!.witnesses.map((witness) => witness.key));
  const survivor = created.statements['schema:inLanguage'].find((row: { id: string }) => !retained.has(row.id)).id;
  for (const witness of initial!.witnesses) {
    tick();
    await post(`/v1/subjects/${created.id}/candidates/${witness.key}:hide`, { reason: 'Bounded proof audit' });
  }
  expect((await store.read(key))?.readiness).toBe('cold');
  expect(await store.readCurrent(key)).toBeNull();
  expect(
    (
      await admin.query('SELECT state FROM semantic.subject_page_repair WHERE route=$1 AND subject_id=$2', [
        key.route,
        key.id,
      ])
    ).rows[0].state,
  ).toBe('pending');
  tick();
  await post(`/v1/subjects/${created.id}/candidates/${survivor}:hide`, { reason: 'Remaining fact' });
  const restoredAt = tick();
  await post(`/v1/subjects/${created.id}/candidates/${survivor}:restore`, { reason: 'Immediate native proof' });
  expect((await store.readCurrent(key))?.lastModified).toBe(restoredAt);
}, 120_000);

test('publication language admission and rank priority use only currently disclosed selections', async () => {
  const { createSubjectPagePublicationStore } = await import('../../src/semantic/subject-page-publication-store.ts');
  const store = createSubjectPagePublicationStore({ pool, access: access!, clock, routeKey });
  const name = (language: string, rank: 'normal' | 'preferred') => ({
    property: { id: 'schema:name' },
    value: { type: 'value', content: { language, text: 'Original name' } },
    rank,
  });
  const subject = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Language admission' },
        statements: {
          'schema:name': [name('ja', 'normal'), name('en-us', 'preferred')],
          'schema:inLanguage': [statement('zh-Hant-TW')],
        },
      },
      201,
    )
  ).subject;
  const key = { route: routeOf(subject.id)!, id: subject.id };
  // This name is admitted as monolingual text, but its tag is outside the Web language rule.
  // A preferred name still excludes normal names before valid tags are selected.
  expect((await store.readCurrent(key))?.originalLanguage).toBe('zh-Hant-TW');
  const preferred = subject.statements['schema:name'].find((fact: { rank: string }) => fact.rank === 'preferred').id;
  tick();
  await post(`/v1/subjects/${subject.id}/candidates/${preferred}:hide`, { reason: 'Withhold preferred name' });
  expect((await store.readCurrent(key))?.originalLanguage).toBe('ja');
  tick();
  await post(`/v1/subjects/${subject.id}/candidates/${preferred}:restore`, { reason: 'Restore rank priority' });
  expect((await store.readCurrent(key))?.originalLanguage).toBe('zh-Hant-TW');
});

test('private Context creation preserves live parent and creation evidence across a changed domain clock', async () => {
  let now = new Date();
  const contextClock = () => now;
  const account = '019a1b2c-3d4e-7f00-8a00-ed170e000192';
  const fixture = await createRealAccess(admin, { editor: account }, ['context:create'], { clock: contextClock });
  await fixture.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'context:create');
  const observations: { stage: string; at?: string; allowed?: boolean }[] = [];
  let unresolved: ReturnType<typeof explainUnresolvedResourceType>;
  let native!: Access;
  const kernel = createKernel({
    pool,
    routeKey,
    clock: contextClock,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(93)]]) },
    writeRate: fixture.writeRate,
    access(config) {
      unresolved = explainUnresolvedResourceType(config.actions, 'semantic.context');
      const base = fixture.access(config);
      native = deriveAccess(base, {
        async authorize(tx, actor, action, resource, evidence, time) {
          const allowed = await base.authorize(tx, actor, action, resource, evidence, time);
          if (time && action === 'context:create') {
            observations.push({
              stage: 'parent authorization',
              at: new Date(authoritativeTimeValue(time)).toISOString(),
              allowed,
            });
            if (allowed) now = new Date(now.getTime() + 37);
          }
          return allowed;
        },
      });
      return native;
    },
  });
  const health = await kernel.handle(
    new Request('http://kernel.test/health', { headers: { authorization: `Bearer ${fixture.bearer('editor')}` } }),
  );
  expect(health.status).toBe(200);
  expect(resourceRoleCatalogue(native)?.types.has('semantic.context')).toBe(true);
  const deadline = Date.now() + 30_000;
  const actor = await native.authenticate(fixture.bearer('editor'), { pool, deadline });
  if (actor.kind !== 'account') throw new Error('Native editor authentication failed');
  const key = randomUUID();
  const target = contextTarget(routeKey, account, key);
  const requestedAt = now.toISOString();
  const authorization = parentCreationAuthorization({
    access: native,
    actor,
    action: 'context:create',
    parent: {
      resource: globalContextAnchor.resource,
      async validate(client, time) {
        const allowed = await globalContextAnchor.validate(client, time);
        observations.push({
          stage: 'Global anchor',
          at: new Date(authoritativeTimeValue(time)).toISOString(),
          allowed,
        });
        return allowed;
      },
    },
    context: {
      pool,
      deadline,
      resource: target,
      creation: {
        async validate(tx, resource, time) {
          const found = await readCreatedContext.run(tx, { route: resource.route, context_id: resource.id });
          observations.push({
            stage: 'native creation provenance',
            at: new Date(authoritativeTimeValue(time)).toISOString(),
            allowed: found !== null,
          });
          return found !== null;
        },
      },
    },
  });
  try {
    await createContext(pool, {
      actor,
      target,
      idempotencyKey: key,
      digest: new Uint8Array(32).fill(94),
      input: { labels: { en: 'Private clock evidence' } },
      authorization,
      deadline,
      clock: contextClock,
    });
  } catch (error) {
    console.error(
      'Native Context evidence',
      JSON.stringify({
        observations,
        unresolved,
        installed: resourceRoleCatalogue(native)?.types.has('semantic.context'),
      }),
    );
    throw error;
  }
  expect(observations).toEqual([
    { stage: 'Global anchor', at: requestedAt, allowed: true },
    { stage: 'parent authorization', at: requestedAt, allowed: true },
    { stage: 'native creation provenance', at: requestedAt, allowed: true },
  ]);
  expect(now.toISOString()).toBe(new Date(Date.parse(requestedAt) + 37).toISOString());
  const { createSubjectPagePublicationStore } = await import('../../src/semantic/subject-page-publication-store.ts');
  const store = createSubjectPagePublicationStore({ pool, access: native, clock: contextClock, routeKey });
  expect(await store.read(target)).toBeNull();
});

test('native publication cost diagnostics identify any degree-wide statement', async () => {
  const db = await openGrowthDatabase();
  try {
    let time = new Date();
    const clock = () => time;
    const tick = () => (time = new Date(time.getTime() + 1000)).toISOString();
    await bootstrapRelease(db.pool, bundledRelease);
    const account = newId(0x193);
    const actions = ['subject:create', 'subject:read', 'moderation:hide', 'moderation:takedown'];
    const fixture = await createRealAccess(db.admin, { editor: account }, actions, { clock });
    for (const action of actions) await fixture.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
      routeOf(account),
      account,
    ]);
    let native!: Access;
    const kernel = createKernel({
      pool: db.pool,
      routeKey,
      clock,
      writeRate: fixture.writeRate,
      access(config) {
        return (native = fixture.access(config));
      },
    });
    const command = async (path: string, body: unknown, status = 200) => {
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fixture.bearer('editor')}`,
            'content-type': 'application/json',
            'idempotency-key': `"${randomUUID()}"`,
          },
          body: JSON.stringify(body),
        }),
      );
      const value = (await response.json()) as Record<string, any>;
      expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
      return value;
    };
    const subject = (
      await command(
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: 'Native degree diagnostics' },
          statements: { 'schema:inLanguage': [statement('ja')] },
        },
        201,
      )
    ).subject;
    const route = routeOf(subject.id)!;
    const selected = subject.statements['schema:inLanguage'][0].id;
    await seed(
      db,
      {
        name: 'native-publication-degree-diagnostics',
        hotPartition: partitionOf(route),
        rows() {
          const id = newId(route);
          const tx = randomUUID();
          const relation = itemFacts(
            subject.id,
            {
              statements: {
                'schema:author': [
                  {
                    property: { id: 'schema:author' },
                    value: { type: 'value', content: id },
                  },
                ],
              },
            },
            'schema:Book',
            bundledRelease,
          )[0]!;
          return {
            'semantic.subject': [
              {
                route,
                subject_id: id,
                type: 'schema:Person',
                recorded_transaction_id: tx,
                current_facts: 1,
                current_release: bundledDigest,
              },
            ],
            'semantic.revision': [
              {
                route,
                subject_id: id,
                revision: 1,
                kind: 'create',
                release: bundledDigest,
                recorded_transaction_id: tx,
              },
            ],
            'semantic.fact': [
              {
                ...relation,
                route,
                subject_id: subject.id,
                recorded_transaction_id: tx,
                release: bundledDigest,
                relation: true,
              },
            ],
          };
        },
      },
      { from: 0, to: 2048 },
    );
    await db.admin.query('VACUUM (ANALYZE)');
    const { createSubjectPagePublicationStore } = await import('../../src/semantic/subject-page-publication-store.ts');
    const store = createSubjectPagePublicationStore({ pool: db.pool, access: native, clock, routeKey });
    const operation = async () => {
      tick();
      await command(`/v1/subjects/${subject.id}/candidates/${selected}:hide`, { reason: 'Degree diagnostic' });
      tick();
      await command(`/v1/subjects/${subject.id}/candidates/${selected}:restore`, { reason: 'Degree diagnostic' });
      expect((await store.readCurrent({ route, id: subject.id }))?.id).toBe(subject.id);
    };
    await operation();
    const measured = await capture(db, operation);
    const expensive = measured.capture.plans.flatMap((plan) => {
      const cost = costOf({ statements: [], plans: [plan] });
      return (cost.relations['semantic.fact']?.rows ?? 0) > 512 ? [{ plan, rows: cost.rows, blocks: cost.blocks }] : [];
    });
    if (expensive.length) console.error('Native degree statement evidence', JSON.stringify(expensive));
    expect(expensive, 'no native publication statement examines unrelated relation degree').toEqual([]);
  } finally {
    await db.close();
  }
}, 120_000);
