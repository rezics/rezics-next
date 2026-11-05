import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createCopyCommands } from '../../src/library/copies.ts';
import { createEntryCommands } from '../../src/library/entries.ts';
import { createFollowCommands } from '../../src/library/follows.ts';
import { createLoanCommands } from '../../src/library/loan-commands.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, costOf, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testAccess, testRouteKey, testTokens } from '../support/test-kernel.ts';

type Kind = 'session' | 'entry' | 'copy' | 'follow' | 'loan';
const time = '2026-10-26T12:00:00.000Z';
const scopes = ['progress_session:read', 'progress_session:list', 'library_entry:read', 'copy:read', 'copy:list'];
const relation = {
  session: 'progress_session',
  entry: 'entry',
  copy: 'copy',
  follow: 'follow',
  loan: 'copy_loan',
} as const;

function id(route: number, ordinal: number): string {
  return `10000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

async function prepareGrowth(route: number, kind: Kind, page: boolean) {
  const database = await openGrowthDatabase();
  try {
    // A separate instrumented pool lets every measured run inspect its own auto_explain notices.
    // checkGrowth still captures the complete read and computes its default five-run median.
    const pool = database.openPool();
    let plans: unknown[] = [];
    let measuredRuns = 0;
    pool.on('connect', (client) => {
      client.on('notice', (notice) => {
        const marker = 'plan:\n';
        if (notice.message?.startsWith('duration:') && notice.message.includes(marker)) {
          plans.push(JSON.parse(notice.message.slice(notice.message.indexOf(marker) + marker.length)));
        }
      });
    });
    const accountId = newId(route);
    const subjectId = newId(route + 0x1000);
    const probeId = id(route, 1);
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
       VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
      [route, accountId],
    );
    const signing = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'personal-reads', alg: 'ES256' };
    const access = testAccess({
      pool,
      actions: new Map(scopes.map((action) => [action, { anonymous: false }])),
      auth: {
        issuer: 'https://auth.example.test',
        audience: 'https://api.rezics.test',
        jwksUrl: 'https://auth.example.test/jwks',
        fetch: async () => Response.json({ keys: [jwk] }),
      },
    });
    const token = await new SignJWT({
      client_id: 'personal-reads',
      scope: scopes.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'personal-reads', typ: 'at+jwt' })
      .setIssuer('https://auth.example.test')
      .setAudience('https://api.rezics.test')
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    const actor = await access.authenticate(token, { pool, deadline: Date.now() + 290_000 });
    const dependencies = { pool, access, tokens: testTokens() };
    const sessions = createSessionCommands(dependencies);
    const entries = createEntryCommands(dependencies);
    const copies = createCopyCommands(dependencies);
    const follows = createFollowCommands(dependencies);
    const loans = createLoanCommands({ ...dependencies, routeKey: testRouteKey() });

    // The page always has the same first 21 neighbours, including its lookahead row.
    const probeSource = `WITH source AS (
      SELECT $1::int AS route, $2::uuid AS account_id, $3::uuid AS subject_id,
        ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid AS row_id,
        $4::timestamptz AS at
      FROM generate_series(1, $5::int) AS n
    )`;
    await database.admin.query(`${probeSource} ${libraryInsert(kind)}`, [
      route,
      accountId,
      subjectId,
      time,
      page ? 21 : 1,
    ]);

    async function operation() {
      plans = [];
      if (page) {
        const result = await sessions.listSessions(actor, subjectId, { limit: 20 });
        expect(result.sessions.map(({ id }) => id)).toEqual(Array.from({ length: 20 }, (_, n) => id(route, n + 1)));
        expect(result.next).toBeString();
      } else if (kind === 'session') {
        expect(await sessions.readSession(actor, probeId)).toMatchObject({ id: probeId, accountId, subjectId });
      } else if (kind === 'entry') {
        expect(await entries.readEntry(actor, subjectId)).toMatchObject({ accountId, subjectId, state: 'planned' });
      } else if (kind === 'copy') {
        expect(await copies.readCopy(actor, probeId)).toMatchObject({
          id: probeId,
          accountId,
          subjectId,
          status: 'owned',
        });
      } else if (kind === 'loan') {
        const result = await loans.listLoans(actor, { filter: 'open', limit: 20 });
        expect(result.items.map(({ loan }) => loan.id)).toEqual(Array.from({ length: 20 }, (_, n) => id(route, n + 1)));
        expect(result.nextCursor).toBeString();
      } else {
        expect(await follows.readFollow(actor, subjectId)).toMatchObject({
          accountId,
          targetId: subjectId,
          state: 'following',
        });
      }
      // Warmups have no plans: explaining is enabled only inside checkGrowth's measured captures.
      if (plans.length > 0) {
        measuredRuns++;
        const cost = costOf({ statements: [], plans });
        expect(cost.relations[`library.${relation[kind]}`]?.rows).toBeGreaterThan(0);
        for (const [name, reads] of Object.entries(cost.relations)) {
          if (name.startsWith('library.')) expect(reads.sequentialScans, name).toBe(0);
        }
      }
    }

    return {
      database,
      operation,
      grow: (db: GrowthDatabase, scale: number, previous: number) =>
        grow(db, kind, route, accountId, subjectId, scale, previous),
      plans: () => plans,
      measuredRuns: () => measuredRuns,
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

function libraryInsert(kind: Kind): string {
  if (kind === 'session')
    return `INSERT INTO library.progress_session
      (route, session_id, account_id, subject_id, mode, unit, state, revision, started_at, transaction_id, completed_unit_count)
      SELECT route, row_id, account_id, subject_id, 'scalar_amount', 'page', 'active', 1, at, row_id, 0 FROM source`;
  if (kind === 'entry')
    return `INSERT INTO library.entry
      (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at, transaction_id)
      SELECT route, account_id, subject_id, NULL, 'planned', 1, at, at, row_id FROM source`;
  if (kind === 'copy')
    return `INSERT INTO library.copy
      (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note,
       revision, created_at, updated_at, transaction_id)
      SELECT route, row_id, account_id, subject_id, 'owned', NULL, NULL, NULL, NULL, NULL, 1, at, at, row_id FROM source`;
  if (kind === 'loan')
    return `INSERT INTO library.copy_loan
      (route, loan_id, account_id, copy_id, direction, counterparty_kind, counterparty_name,
       counterparty_person_id, started_on, due_on, returned_on, revision, created_at, updated_at, transaction_id)
      SELECT route, row_id, account_id, row_id, 'lent', 'name', 'growth reader', NULL,
        '2026-10-20', '9999-12-31', NULL, 1, at, at, row_id FROM source`;
  return `INSERT INTO library.follow
    (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
    SELECT route, account_id, subject_id, 'subject', 'following', 'explicit', at, at, row_id FROM source`;
}

async function grow(
  database: GrowthDatabase,
  kind: Kind,
  route: number,
  accountId: string,
  subjectId: string,
  scale: number,
  previous: number,
) {
  // Each bucket adds 500 x scale rows: the reader, another account in its partition,
  // and accounts in another partition. Session growth shares the probe subject;
  // those sessions start earlier, keeping the returned page and lookahead fixed.
  const source = `WITH placed AS (
    SELECT n, bucket, CASE WHEN bucket = 2 THEN $1::int + 8192 ELSE $1::int END AS route
    FROM generate_series($2::int + 1, $3::int) AS n CROSS JOIN (VALUES (0), (1), (2)) AS buckets(bucket)
  ), identified AS (
    SELECT *, ('20000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(n * 3 + bucket), 8, '0'))::uuid AS row_id
    FROM placed
  ), source AS (
    SELECT *, CASE WHEN bucket = 0 THEN $4::uuid ELSE row_id END AS account_id,
      CASE WHEN $6::boolean THEN $5::uuid
        ELSE ('30000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(n * 3 + bucket), 8, '0'))::uuid END AS subject_id,
      '2026-10-25T12:00:00.000Z'::timestamptz AS at, n * 3 + bucket + 1000 AS position
    FROM identified
  )`;
  const parameters = [route, previous * 500, scale * 500, accountId, subjectId, kind === 'session'];
  await database.admin.query(
    `${source} INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     SELECT route, row_id, 'actor', 'active', row_id, false, 1, true FROM source`,
    parameters,
  );
  const growInsert =
    kind === 'loan'
      ? `INSERT INTO library.copy_loan
          (route, loan_id, account_id, copy_id, direction, counterparty_kind, counterparty_name,
           counterparty_person_id, started_on, due_on, returned_on, revision, created_at, updated_at, transaction_id)
         SELECT route, row_id, account_id, row_id, 'lent', 'name', 'retained history', NULL,
           '2018-01-01', '2018-02-01', '2019-01-01', 2, at, at, row_id FROM source`
      : libraryInsert(kind);
  await database.admin.query(`${source} ${growInsert}`, parameters);
  await database.admin.query(
    `${source} INSERT INTO core.receipt
      (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
       epoch, position, transaction_id, response)
     SELECT route >> 4, 'account', account_id, 'library.fixture', row_id::text, decode(repeat('00', 32), 'hex'),
       1, position, row_id, '{}'::jsonb FROM source`,
    parameters,
  );
  await database.admin.query(
    `${source} INSERT INTO core.outbox
      (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
     SELECT route >> 4, position, 0, 1, 1, row_id, $7, account_id::text,
       jsonb_build_object($8::text, CASE WHEN $8::text IN ('sessionId', 'copyId') THEN row_id ELSE subject_id END), at FROM source`,
    [
      ...parameters,
      `com.rezics.library.${relation[kind]}.updated.v1`,
      kind === 'session' ? 'sessionId' : kind === 'copy' ? 'copyId' : kind === 'follow' ? 'targetId' : 'subjectId',
    ],
  );
  await database.admin.query(
    `${source} INSERT INTO editorial.write_basis
      (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by, recorded_at)
     SELECT route >> 4, row_id, 1, position, 'account', account_id, 'personal-reads', NULL, at FROM source`,
    parameters,
  );
  await database.admin.query(
    `UPDATE core.partition SET position = GREATEST(position, $2::bigint)
     WHERE partition_no = ANY($1::int[])`,
    [[partitionOf(route), partitionOf(route + 8192)], scale * 1500 + 1002],
  );
}

async function check(name: string, kind: Kind, route: number, page = false) {
  const prepared = await prepareGrowth(route, kind, page);
  try {
    const report = await checkGrowth(prepared.database, {
      name,
      scales: [1, 4, 16],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: prepared.grow,
      operation: prepared.operation,
    });
    expect(prepared.measuredRuns()).toBe(15);
    console.info(
      JSON.stringify({
        name,
        samples: report.samples.map(({ scale, cost: { rows, blocks, statements } }) => ({
          scale,
          rows,
          blocks,
          statements,
        })),
      }),
    );
  } catch (error) {
    if (error instanceof GrowthBoundError) {
      console.error(JSON.stringify({ message: error.message, samples: error.samples, plans: prepared.plans() }));
    }
    throw error;
  } finally {
    await prepared.database.close();
  }
}

test('Session read has constant rows and statements as sessions grow', async () => {
  await check('Session read has constant rows and statements as sessions grow', 'session', 0x51b0);
}, 60_000);

test('Session page at a fixed limit has constant rows and statements as sessions grow', async () => {
  await check(
    'Session page at a fixed limit has constant rows and statements as sessions grow',
    'session',
    0x51c0,
    true,
  );
}, 60_000);

test('Entry read has constant rows and statements as entries grow', async () => {
  await check('Entry read has constant rows and statements as entries grow', 'entry', 0x51d0);
}, 60_000);

test('Copy read has constant rows and statements as copies grow', async () => {
  await check('Copy read has constant rows and statements as copies grow', 'copy', 0x51e0);
}, 60_000);

test('Follow read has constant rows and statements as follows grow', async () => {
  await check('Follow read has constant rows and statements as follows grow', 'follow', 0x51f0);
}, 60_000);

test('Open loan page at a fixed limit ignores unrelated retained history growth', async () => {
  await check('Open loan page ignores returned history growth', 'loan', 0x51a0, true);
}, 60_000);
