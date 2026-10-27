import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { accessCheck, type Access } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population, type Row } from '../support/growth.ts';

// Shared interface declarations only: importing these types never registers this test elsewhere.
export type SubjectKey = { route: number; id: string };
export type PublicationEntry = { id: string; labels: { language: string; value: string }[]; lastModified?: string };
export type PublicationSnapshot = {
  generation: string;
  readiness: 'cold' | 'repairing' | 'ready';
  publicEffectiveAt: string | null;
  evidence: 'known' | 'missing';
  completedPosition: string;
  witnesses: { kind: 'fact' | 'cover' | 'relation'; key: string }[];
};
export type PublicationStore = {
  read(subject: SubjectKey): Promise<PublicationSnapshot | null>;
  readCurrent(subject: SubjectKey): Promise<PublicationEntry | null>;
};
export type PublicationRunner = {
  requestRebuild(subject: SubjectKey): Promise<void>;
  step(options: { limit: number }): Promise<{ processed: number; next: string | null; done: boolean }>;
};

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const origin = Date.now();
let now = new Date(origin);
let liveTime = '';
const clock = () => now;
const at = (n: number) => (now = new Date(origin + n * 1000)).toISOString();
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000181' };
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
  'moderation:hide',
];
const routeKey = new Uint8Array(32).fill(81);
const real = await createRealAccess(admin, accounts, actions, { clock });
let access: Access;
const app = createKernel({
  pool,
  routeKey,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
  clock,
  writeRate: real.writeRate,
  access(config) {
    const base = real.access(config);
    access = deriveAccess(base, {
      async authorize(tx, actor, action, resource, evidence, time) {
        const allowed = await base.authorize(tx, actor, action, resource, evidence, time);
        if (allowed && time && !action.endsWith(':read')) {
          liveTime = authoritativeTimeValue(time);
          // Make a second domain-clock call observably wrong without replacing command execution.
          now = new Date(now.getTime() + 37);
        }
        return allowed;
      },
    });
    return access;
  },
});
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(accounts.editor),
    accounts.editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
}, 60_000);
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
    value.retryable === true &&
    value.effect_status === 'not_applied';
    retry++
  ) {
    response = await send();
    value = (await response.json()) as Record<string, any>;
  }
  expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
  return value;
}
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function proposal(id: string, content: string) {
  return (
    await post(
      `/v1/subjects/${id}/candidates`,
      {
        statement: {
          ...statement('schema:inLanguage', content),
          references: [{ parts: [statement('schema:url', 'https://example.test/source')] }],
        },
      },
      201,
    )
  ).candidate as string;
}
async function select(id: string, candidate: string, context = GLOBAL_CONTEXT) {
  await post(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context, expected_head: null });
  const result = await admin.query(
    `SELECT max(head)::int AS head FROM semantic.adoption
    WHERE route=$1 AND subject_id=$2 AND context_id=$3`,
    [routeOf(id), id, context],
  );
  await post(`/v1/subjects/${id}:adopt`, {
    context,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: result.rows[0].head,
  });
}

test('local public component changes retain command time while private activity and replay do not', async () => {
  at(1);
  const subject = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Local clock' },
        statements: {
          'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
          'schema:url': [statement('schema:url', 'https://example.test/survivor')],
        },
      },
      201,
    )
  ).subject;
  const createdAt = liveTime;
  expect(createdAt).not.toBe('');
  // No feed route, repair runner or Content implementation is required for this slice.
  const path = '../../src/semantic/subject-page-publication-store.ts';
  const module = await import(path).catch(() => ({}));
  expect(typeof (module as any).createSubjectPagePublicationStore, 'production store factory').toBe('function');
  const store: PublicationStore = (module as any).createSubjectPagePublicationStore({
    pool,
    access: access!,
    clock,
    routeKey,
  });
  const indexes = (
    await admin.query(`SELECT tablename, indexdef FROM pg_indexes
    WHERE schemaname='semantic' AND tablename LIKE 'subject_page_%'`)
  ).rows;
  const primaryKeys = {
    subject_page_publication: '(route, subject_id)',
    subject_page_component: '(route, subject_id, component_kind, component_key)',
    subject_page_dependency: '(route, subject_id, owner_kind, owner_route, owner_key, component_key)',
    subject_page_change: '(route, subject_id, position)',
    subject_page_repair: '(route, subject_id)',
    subject_page_fanout: '(owner_kind, owner_route, owner_key, change_id)',
  };
  for (const [table, columns] of Object.entries(primaryKeys)) {
    const constraint = await admin.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=$1::regclass AND contype='p'`,
      [`semantic.${table}`],
    );
    expect(constraint.rows.map((row) => row.definition)).toEqual([`PRIMARY KEY ${columns}`]);
  }
  for (const [table, columns] of [
    ['subject_page_dependency', '(owner_kind, owner_route, owner_key, route, subject_id, component_key)'],
    ['subject_page_change', '(route, subject_id, change_id)'],
    ['subject_page_repair', '(state, available_at, route, subject_id)'],
  ])
    expect(indexes.some((row) => row.tablename === table && row.indexdef.includes(columns))).toBe(true);
  expect(
    indexes.some(
      (row) =>
        row.tablename === 'subject_page_change' &&
        row.indexdef.includes('UNIQUE INDEX') &&
        row.indexdef.includes('(route, subject_id, change_id)'),
    ),
  ).toBe(true);
  expect(
    (
      await admin.query(`SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='semantic' AND table_name='subject_page_publication' AND column_name='public_effective_at'`)
    ).rows,
  ).toEqual([{ is_nullable: 'YES' }]);
  const key = { route: routeOf(subject.id)!, id: subject.id };
  async function shown(time: string, label = 'Local clock') {
    const snapshot = await store.read(key);
    expect(snapshot?.publicEffectiveAt).toBe(time);
    expect(snapshot?.evidence).toBe('known');
    expect(snapshot!.witnesses.length).toBeGreaterThan(0);
    expect(snapshot!.witnesses.length).toBeLessThanOrEqual(8);
    expect(new Set(snapshot!.witnesses.map((w) => `${w.kind}:${w.key}`)).size).toBe(snapshot!.witnesses.length);
    expect(await store.readCurrent(key)).toEqual({
      id: subject.id,
      labels: [{ language: 'en', value: label }],
      lastModified: time,
    });
  }
  await shown(createdAt);
  at(2);
  const candidate = await proposal(subject.id, 'en');
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  const unshown = await proposal(subject.id, 'fr');
  await post(`/v1/subjects/${subject.id}/candidates/${unshown}:hide`, { reason: 'Never shown' });
  const context = (await post('/v1/contexts', { labels: { en: 'Private' } }, 201)).context.id;
  const privateCandidate = await proposal(subject.id, 'de');
  await select(subject.id, privateCandidate, context);
  await shown(createdAt);
  const head = await admin.query(
    `SELECT max(head)::int AS head FROM semantic.adoption
    WHERE route=$1 AND subject_id=$2 AND context_id=$3`,
    [key.route, key.id, GLOBAL_CONTEXT],
  );
  at(3);
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: head.rows[0].head,
  });
  await shown(liveTime);
  at(4);
  const hidePath = `/v1/subjects/${subject.id}/candidates/${candidate}:hide`;
  const hideBody = { reason: 'Selected removal' };
  const receipt = randomUUID();
  await post(hidePath, hideBody, 200, receipt);
  const hiddenAt = liveTime;
  await shown(hiddenAt);
  at(5);
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:restore`, { reason: 'Selected restoration' });
  const restoredAt = liveTime;
  await shown(restoredAt);
  const beforeReplay = await store.read(key);
  at(6);
  await post(hidePath, hideBody, 200, receipt);
  expect(await store.read(key)).toEqual(beforeReplay);
  await shown(restoredAt);

  // Identity writes use the real Access formula at the live attempt, as the native helper requires.
  const actor = await access!.authenticate(real.bearer('editor'), { pool, deadline: Date.now() + 30_000 });
  const authorize = await accessCheck(
    access!,
    actor,
    'subject:create',
    { route: 0, id: GLOBAL_CONTEXT },
    { pool, deadline: Date.now() + 30_000 },
  );
  const labelRequestedAt = at(7);
  const identityOptions = {
    subject: subject.id,
    labels: { en: 'Changed label' },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize,
    clock,
  };
  await updateSubjectIdentity(pool, identityOptions);
  expect(liveTime, 'identity commands must forward the configured domain clock').toBe(labelRequestedAt);
  const labelAt = liveTime;
  await shown(labelAt, 'Changed label');
  const title = (await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Title only' } }, 201)).subject;
  expect(await store.readCurrent({ route: routeOf(title.id)!, id: title.id })).toBeNull();
  const privateOnly = await proposal(title.id, 'fr');
  expect(await store.readCurrent({ route: routeOf(title.id)!, id: title.id })).toBeNull();
  await select(title.id, privateOnly, context);
  expect(await store.readCurrent({ route: routeOf(title.id)!, id: title.id })).toBeNull();
  await post(`/v1/subjects/${subject.id}:hide`, { reason: 'Original gate overrides stored witness' });
  expect(await store.readCurrent(key)).toBeNull();

  // Legal legacy source rows only: no publication/component/dependency truth or retained command time.
  const oldId = newId(0);
  const tx = randomUUID();
  await admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
    VALUES (0,$1,'schema:Book',$2,2,$3)`,
    [oldId, tx, bundledDigest],
  );
  await admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
    VALUES (0,$1,1,'create',$2,$3)`,
    [oldId, bundledDigest, tx],
  );
  for (const fact of itemFacts(
    oldId,
    {
      labels: { en: 'Legacy' },
      statements: {
        'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
      },
    },
    'schema:Book',
    bundledRelease,
  )) {
    const row = {
      ...fact,
      route: 0,
      subject_id: oldId,
      recorded_transaction_id: tx,
      release: fact.kind === 'statement' ? bundledDigest : null,
    };
    const keys = Object.keys(row);
    await admin.query(
      `INSERT INTO semantic.fact (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }
  const oldKey = { route: 0, id: oldId };
  await admin.query(`INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES (0,1)
    ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+1`);
  expect((await store.read(oldKey))?.publicEffectiveAt ?? null).toBeNull();
  at(8);
  const next = await proposal(oldId, 'en');
  expect((await store.read(oldKey))?.publicEffectiveAt ?? null).toBeNull();
  at(9);
  await select(oldId, next);
  expect((await store.read(oldKey))?.publicEffectiveAt).toBe(liveTime);
  expect((await store.readCurrent(oldKey))?.lastModified).toBe(liveTime);
}, 120_000);

test('native publication transition and current proof cost excludes unrelated components and history', async () => {
  const db = await openGrowthDatabase();
  try {
    await bootstrapRelease(db.pool, bundledRelease);
    const growthAccounts = { editor: newId(0x186) };
    const fixture = await createRealAccess(db.admin, growthAccounts, actions, { clock });
    for (const action of actions) await fixture.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
      routeOf(growthAccounts.editor),
      growthAccounts.editor,
    ]);
    const routeKey = new Uint8Array(32).fill(87);
    let resolved: Access;
    const kernel = createKernel({
      pool: db.pool,
      routeKey,
      clock,
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(88)]]) },
      writeRate: fixture.writeRate,
      access(config) {
        resolved = fixture.access(config);
        return resolved;
      },
    });
    async function command(path: string, body: unknown, status = 200) {
      const key = randomUUID();
      const send = () =>
        kernel.handle(
          new Request(`http://kernel.test${path}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${fixture.bearer('editor')}`,
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
        value.retryable === true &&
        value.effect_status === 'not_applied';
        retry++
      ) {
        response = await send();
        value = (await response.json()) as Record<string, any>;
      }
      expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
      return value;
    }
    const subject = (
      await command(
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: 'Growth command' },
          statements: {
            'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
          },
        },
        201,
      )
    ).subject;
    const route = routeOf(subject.id)!;
    const key = { route, id: subject.id };
    const selected = subject.statements['schema:inLanguage'][0].id;
    const path = '../../src/semantic/subject-page-publication-store.ts';
    const module = await import(path).catch(() => ({}));
    expect(typeof (module as any).createSubjectPagePublicationStore).toBe('function');
    const store: PublicationStore = (module as any).createSubjectPagePublicationStore({
      pool: db.pool,
      access: resolved!,
      clock,
      routeKey,
    });
    for (const axis of ['population', 'noindex', 'history', 'degree'] as const) {
      const population: Population = {
        name: `native-publication-${axis}`,
        hotPartition: route >> 4,
        rows: ({ ordinal }) => {
          const otherRoute = axis === 'population' ? route ^ 0xfff0 : route;
          const id = newId(otherRoute);
          const tx = randomUUID();
          if (axis === 'history')
            return {
              'semantic.revision': [
                {
                  route,
                  subject_id: subject.id,
                  revision: ordinal + 2,
                  kind: 'propose',
                  release: bundledDigest,
                  recorded_transaction_id: tx,
                },
              ],
              'semantic.candidate': [
                {
                  route,
                  subject_id: subject.id,
                  candidate_id: newId(route),
                  slot_id: newId(route),
                  property: 'schema:inLanguage',
                  rank: 'normal',
                  statement: { value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] },
                  release: bundledDigest,
                  revision: ordinal + 2,
                  origin: 'proposal',
                  view_order: 0,
                },
              ],
            };
          const rows: Record<string, Row[]> = {
            'semantic.subject': [
              {
                route: otherRoute,
                subject_id: id,
                type: axis === 'degree' ? 'schema:Person' : 'schema:Book',
                recorded_transaction_id: tx,
                current_facts: 1,
                current_release: bundledDigest,
              },
            ],
            'semantic.revision': [
              {
                route: otherRoute,
                subject_id: id,
                revision: 1,
                kind: 'create',
                release: bundledDigest,
                recorded_transaction_id: tx,
              },
            ],
            'semantic.fact': itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } }).map((f) => ({
              ...f,
              route: otherRoute,
              subject_id: id,
              recorded_transaction_id: tx,
            })),
          };
          if (axis === 'degree') {
            const relation = itemFacts(
              subject.id,
              { statements: { 'schema:author': [statement('schema:author', id)] } },
              'schema:Book',
              bundledRelease,
            )[0]!;
            rows['semantic.fact']!.push({
              ...relation,
              route,
              subject_id: subject.id,
              recorded_transaction_id: tx,
              release: bundledDigest,
              relation: true,
            });
            rows['semantic.outbound_link'] = [
              {
                route,
                subject_id: subject.id,
                property: 'schema:author',
                context_id: GLOBAL_CONTEXT,
                filter_value: '00000000-0000-0000-0000-000000000000',
                order_key: String(ordinal).padStart(8, '0'),
                target_subject_id: id,
                statement_id: relation.statement_id,
                slot_id: relation.slot_id,
                relation: true,
                source_type: 'schema:Book',
                source_revision: 1,
                target_type: 'schema:Person',
                value: 'value',
                present: true,
                recorded_transaction_id: tx,
              },
            ];
            rows['semantic.inbound_link'] = [
              {
                route,
                subject_id: id,
                property: 'schema:author',
                source_subject_id: subject.id,
                statement_id: relation.statement_id,
                source_revision: 1,
                present: true,
                recorded_transaction_id: tx,
              },
            ];
          }
          return rows;
        },
        finish: async (admin, range) => {
          if (axis !== 'history')
            await admin.query(
              `INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES ($1,$2)
            ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+EXCLUDED.visible`,
              [(axis === 'population' ? route ^ 0xfff0 : route) >> 4, range.to - range.from],
            );
          if (axis === 'degree')
            await admin.query(
              `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
            VALUES ($1,$2,'schema:author','00000000-0000-0000-0000-000000000000',$3)
            ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
              [route, subject.id, range.to],
            );
        },
      };
      const report = await checkGrowth(db, {
        name: `native publication transition and current proof: ${axis}`,
        scales: [1, 8, 64],
        warmups: 1,
        repetitions: 3,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (database, scale, previous) => {
          await seed({ pool: database.pool, admin: database.admin }, population, {
            from: previous * 32,
            to: scale * 32,
          });
        },
        operation: async () => {
          now = new Date(now.getTime() + 1000);
          await command(`/v1/subjects/${subject.id}/candidates/${selected}:hide`, { reason: 'Changed component only' });
          now = new Date(now.getTime() + 1000);
          await command(`/v1/subjects/${subject.id}/candidates/${selected}:restore`, {
            reason: 'Changed component only',
          });
          expect((await store.read(key))?.publicEffectiveAt).toBe(now.toISOString());
          expect((await store.readCurrent(key))?.id).toBe(subject.id);
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
      for (const sample of report.samples) {
        expect(sample.repetitions).toHaveLength(3);
        const names = Object.keys(sample.cost.relations);
        expect(names.some((name) => /subject_page_publication/.test(name))).toBe(true);
        expect(names.some((name) => /fact|outbound_link/.test(name))).toBe(true);
        expect(names.some((name) => /permission|grant|policy|closure|resource|moderation/.test(name))).toBe(true);
      }
    }
  } finally {
    await db.close();
  }
}, 240_000);
