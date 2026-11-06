import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { createPublishedLogCommands } from '../../src/library/published-logs.ts';
import type { Actor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { checkGrowth, costOf, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { testTokens } from '../support/test-kernel.ts';

const anonymous: Actor = { kind: 'anonymous' };
const time = '2026-10-26T08:00:00.000Z';
const scopes = ['subject:read', 'published_log:create', 'published_log:delete'];
type Operation = 'publish' | 'retract' | 'read' | 'page';

function id(prefix: string, route: number, ordinal: number): string {
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

// Each of three populations receives `scale` rows: the owner, another account on its route,
// and accounts on a different partition. IDs and timestamps never overlap the probes.
const source = `WITH placement AS (
  SELECT n, bucket, CASE WHEN bucket = 2 THEN $1::int + 4096 ELSE $1::int END AS route,
         n * 3 + bucket AS ordinal
  FROM generate_series($2::int + 1, $3::int) AS n CROSS JOIN generate_series(0, 2) AS bucket
), source AS (
  SELECT *, route >> 4 AS partition_no, $5::timestamptz AS started_at, $6::uuid AS subject_id,
    CASE WHEN bucket = 0 THEN $4::uuid ELSE
      ('10000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid END AS account_id,
    ('20000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid AS session_id,
    ('30000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid AS log_id,
    ('40000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid AS transaction_id
  FROM placement
)`;

async function grow(
  database: GrowthDatabase,
  route: number,
  owner: string,
  subjectId: string,
  scale: number,
  previous: number,
) {
  const parameters = [route, previous, scale, owner, time, subjectId];
  await database.admin.query(
    `${source}
     INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     SELECT route,
       ('10000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid,
       'actor', 'active', transaction_id, false, 1, true FROM source`,
    parameters,
  );
  await database.admin.query(
    `${source}
     INSERT INTO library.progress_session
       (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state, revision,
        started_at, transaction_id)
     SELECT route, session_id, account_id, subject_id, 'scalar_amount', 'page', 0, 'active', 1, $5::timestamptz,
            transaction_id FROM source`,
    parameters,
  );
  await database.admin.query(
    `${source}
     INSERT INTO library.published_log
       (route, log_id, account_id, session_id, subject_id, session_state, started_at, completed_at, note,
        published_at, transaction_id)
     SELECT route, log_id, account_id, session_id, subject_id, 'active', $5::timestamptz, NULL, 'Growing snapshot',
            $5::timestamptz - n * interval '1 second', transaction_id FROM source`,
    parameters,
  );
  await database.admin.query(
    `${source}
     INSERT INTO core.outbox
       (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
     SELECT partition_no, ordinal, 0, 1, 1, transaction_id,
            'com.rezics.library.published_log.updated.v1', account_id::text,
            jsonb_build_object('logId', log_id), $5::timestamptz FROM source`,
    parameters,
  );
  await database.admin.query(
    `${source}
     INSERT INTO editorial.write_basis
       (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, recorded_at)
     SELECT partition_no, transaction_id, 1, ordinal, 'account', account_id, 'published-logs-growth',
            $5::timestamptz FROM source`,
    parameters,
  );
  await database.admin.query(
    `${source}
     INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
        epoch, position, transaction_id, response, created_at)
     SELECT partition_no, 'account', account_id,
            CASE WHEN n % 2 = 0 THEN 'published_log.create' ELSE 'published_log.delete' END,
            'seed-' || ordinal, decode(repeat('ab', 32), 'hex'), 1, ordinal, transaction_id,
            jsonb_build_object('id', log_id, 'accountId', account_id, 'subjectId', subject_id,
              'sessionState', 'active', 'startedAt', $5::text, 'completedAt', NULL,
              'note', 'Growing snapshot', 'publishedAt', $5::text), $5::timestamptz FROM source`,
    parameters,
  );
  // Keep command positions beyond every seeded event, including later scales.
  await database.admin.query(
    `UPDATE core.partition SET position = GREATEST(position, 1000000)
     WHERE partition_no IN ($1, $2)`,
    [partitionOf(route), partitionOf(route + 4096)],
  );
}

async function prepare(route: number) {
  const database = await openGrowthDatabase();
  try {
    configureTestReceiptKeys(database.pool);
    await bootstrapRelease(database.pool, bundledRelease);
    const owner = newId(route);
    const sessionId = newId(route);
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
       VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
      [route, owner],
    );
    const signing = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'published-logs-growth' };
    const access = createAccess({
      actions: new Map(scopes.map((scope) => [scope, { anonymous: scope === 'subject:read' }])),
      auth: {
        issuer: 'https://published-logs-growth.auth.test',
        audience: 'https://published-logs-growth.api.test',
        jwksUrl: 'https://published-logs-growth.auth.test/jwks',
        fetch: async () => Response.json({ keys: [jwk] }),
      },
    });
    const token = await new SignJWT({
      client_id: 'published-logs-growth',
      scope: scopes.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer('https://published-logs-growth.auth.test')
      .setAudience('https://published-logs-growth.api.test')
      .setSubject(owner)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    const actor = await access.authenticate(token, { pool: database.pool, deadline: Date.now() + 290_000 });
    if (actor.kind !== 'account') throw new TypeError('Published-log growth owner must authenticate as an account');
    const requestKey = randomUUID();
    const created = await createSubject(database.pool, {
      actor,
      target: subjectTarget(new Uint8Array(32).fill(81), owner, requestKey),
      idempotencyKey: requestKey,
      digest: createHash('sha256').update(requestKey).digest(),
      item: { type: 'schema:Book', labels: { en: 'Published log growth subject' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });
    const subjectId = created.subject.id;
    const commands = createPublishedLogCommands({ pool: database.pool, access, tokens: testTokens() });
    await database.admin.query(
      `INSERT INTO library.progress_session
         (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state, revision,
          started_at, transaction_id)
       VALUES ($1, $2, $3, $4, 'scalar_amount', 'page', 0, 'active', 1, $5, $2)`,
      [route, sessionId, owner, subjectId, time],
    );
    const probes = Array.from({ length: 40 }, (_, index) => id('60000000', route, index));
    await database.admin.query(
      `INSERT INTO library.published_log
         (route, log_id, account_id, session_id, subject_id, session_state, started_at, completed_at, note,
          published_at, transaction_id)
       SELECT $1, log_id, $2, $3, $4, 'active', $5::timestamptz, NULL, 'Fixed snapshot',
              $5::timestamptz + interval '1 day', log_id FROM unnest($6::uuid[]) AS log_id`,
      [route, owner, sessionId, subjectId, time, probes],
    );
    return { database, owner, actor, sessionId, subjectId, commands, probes };
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function check(operation: Operation, route: number, name: string) {
  const fixture = await prepare(route);
  const { database, owner, actor, sessionId, subjectId, commands, probes } = fixture;
  const plans: { scale: number; repetition: number; plans: unknown[] }[] = [];
  try {
    async function run(_database: GrowthDatabase, scale: number, repetition: number, measured = true) {
      // checkGrowth owns the capture. Observe its auto_explain notices to assert each
      // run's relation costs, rather than only the median reported for the scale.
      const runPlans: unknown[] = [];
      const clients = new Set<PoolClient>();
      const notice = (event: { message?: string | undefined }) => {
        const message = event.message;
        const marker = 'plan:\n';
        if (typeof message === 'string' && message.startsWith('duration:') && message.includes(marker))
          runPlans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)));
      };
      const acquire = (client: PoolClient) => {
        if (clients.has(client)) return;
        clients.add(client);
        client.on('notice', notice);
      };
      database.pool.on('acquire', acquire);
      try {
        if (operation === 'publish') {
          const result = await commands.publishLog(actor, { sessionId, note: 'Fixed snapshot' }, randomUUID());
          expect(result.replayed).toBe(false);
          expect(result.value).toMatchObject({ accountId: owner, subjectId, sessionState: 'active' });
        } else if (operation === 'retract') {
          const result = await commands.retractLog(actor, probes[repetition]!, randomUUID(), 1);
          expect(result.replayed).toBe(false);
          expect(result.value.id).toBe(probes[repetition]!);
        } else if (operation === 'read') {
          expect(await commands.readPublishedLog(anonymous, probes[0]!)).toMatchObject({
            id: probes[0],
            accountId: owner,
            subjectId,
            note: 'Fixed snapshot',
          });
        } else {
          const page = await commands.listPublishedLogs(anonymous, { accountId: owner, limit: 20 });
          expect(page.publishedLogs.map((log) => log.id)).toEqual(probes.slice(0, 20));
          expect(page.next).toBeString();
        }
      } finally {
        database.pool.removeListener('acquire', acquire);
        for (const client of clients) client.removeListener('notice', notice);
      }
      if (!measured) return;
      plans.push({ scale, repetition, plans: runPlans });
      const cost = costOf({ statements: [], plans: runPlans });
      const library = Object.entries(cost.relations).filter(([relation]) => relation.startsWith('library.'));
      expect(library.length).toBeGreaterThan(0);
      for (const [relation] of library)
        expect(cost.relations[relation]!.sequentialScans, `${name}: ${relation} at ${scale}/${repetition}`).toBe(0);
    }

    const report = await checkGrowth(database, {
      name,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (db, scale, previous) => grow(db, route, owner, subjectId, scale, previous),
      operation: run,
      warmup: (db, scale, repetition) => run(db, scale, repetition, false),
    });
    console.log(
      JSON.stringify({
        check: name,
        samples: report.samples.map(({ scale, cost: { rows, blocks, statements } }) => ({
          scale,
          rows,
          blocks,
          statements,
        })),
      }),
    );
  } catch (error) {
    if (error instanceof GrowthBoundError)
      console.error(JSON.stringify({ message: error.message, samples: error.samples, plans }));
    throw error;
  } finally {
    await database.close();
  }
}

test('Publish has constant rows and statements as published logs grow', async () => {
  await check('publish', 0x21c0, 'Publish has constant rows and statements as published logs grow');
});

test('Retract has constant rows and statements as published logs grow', async () => {
  await check('retract', 0x21d0, 'Retract has constant rows and statements as published logs grow');
});

test('Published log read has constant rows and statements as published logs grow', async () => {
  await check('read', 0x21e0, 'Published log read has constant rows and statements as published logs grow');
});

test('Published log page at a fixed limit has constant rows and statements as published logs grow', async () => {
  await check(
    'page',
    0x21f0,
    'Published log page at a fixed limit has constant rows and statements as published logs grow',
  );
});
