import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const scales = [1, 4, 16] as const;
const ordinalsPerScale = 500;
const routeKey = new Uint8Array(32).fill(7);
let database: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;

const profile = (text: string): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'title', text, level: 2 } }] },
  bases: [],
  types: [],
  routes: [],
});

function profileHistory(name: string, head: { next: number }): Population {
  return {
    name,
    hotPartition: 0,
    hotShare: 1,
    // Profiles and their activation history match the route-zero production rows.
    rows: ({ ordinal }) => {
      const body = profile(`${name}-${ordinal}`);
      const digest = profileDigest(body);
      const transactionId = newId(0);
      return {
        'presentation.profile': [{ route: 0, digest, body, recorded_transaction_id: transactionId }],
        'presentation.profile_activation': [
          { route: 0, head: head.next++, digest, recorded_transaction_id: transactionId },
        ],
      };
    },
  };
}

function unrelatedContexts(name: string, contextIds: string[]): Population {
  return {
    name,
    hotPartition: 0,
    hotShare: 0.5,
    // Global Context authorization reads semantic.context by its exact key while other Contexts share and cross partitions.
    rows: ({ ordinal, route }) => {
      const contextId = newId(route);
      contextIds.push(contextId);
      return {
        'semantic.context': [
          {
            route,
            context_id: contextId,
            kind: 'community',
            labels: { en: `Growth context ${name} ${ordinal}` },
            recorded_transaction_id: newId(route),
          },
        ],
      };
    },
  };
}

async function insertProfiles(targets: readonly { digest: string; body: PresentationProfile }[]): Promise<void> {
  const records = targets.map(({ digest, body }) => ({
    route: 0,
    digest,
    body,
    recorded_transaction_id: newId(0),
  }));
  await database.admin.query(
    `INSERT INTO presentation.profile (route, digest, body, recorded_transaction_id)
     SELECT route, digest, body, recorded_transaction_id
     FROM jsonb_populate_recordset(NULL::presentation.profile, $1::jsonb)`,
    [JSON.stringify(records)],
  );
}

async function request(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await kernel.handle(new Request(`http://kernel.test${path}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function checkRouteGrowth(kind: 'profile' | 'active-profile'): Promise<void> {
  await database.admin.query('TRUNCATE presentation.profile_activation, presentation.profile');

  const runId = `${kind}-${randomUUID()}`;
  const contextIds: string[] = [];
  const targets = new Map<number, { digest: string; body: PresentationProfile }>();
  const head = { next: 1 };
  let nextRepetition = 0;
  const profiles = profileHistory(`${runId}-history`, head);
  const contexts = unrelatedContexts(`${runId}-contexts`, contextIds);

  const read = async (growth: GrowthDatabase, repetition: number): Promise<void> => {
    const target = targets.get(repetition);
    if (!target) throw new Error(`Missing warm-up/sample profile for repetition ${repetition}`);

    if (kind === 'profile') {
      const result = await request(`/v1/presentation/profiles/${target.digest}`);
      if (result.status !== 200) throw new Error(`profile route returned ${result.status}`);
      expect(result.body).toEqual({ digest: target.digest, profile: target.body });
      return;
    }

    const activeHead = head.next++;
    await growth.admin.query(
      `INSERT INTO presentation.profile_activation (route, head, digest, recorded_transaction_id)
       VALUES (0, $1, $2, $3)`,
      [activeHead, target.digest, newId(0)],
    );
    const result = await request('/v1/presentation/active');
    if (result.status !== 200) throw new Error(`active-profile route returned ${result.status}`);
    expect(result.body).toEqual({ digest: target.digest, head: activeHead });
  };

  try {
    const report = await checkGrowth(database, {
      name: `${kind} route with Global Context authorization`,
      scales,
      bounds,
      repetitions: 1,
      warmups: 1,
      async grow(growth, scale, previous) {
        const range = { from: previous * ordinalsPerScale, to: scale * ordinalsPerScale };
        await seed({ pool: growth.pool, admin: growth.admin }, profiles, range);
        await seed({ pool: growth.pool, admin: growth.admin }, contexts, range);

        const additions: { digest: string; body: PresentationProfile }[] = [];
        for (let index = 0; index < 2; index++) {
          const repetition = nextRepetition++;
          const body = profile(`${runId}-target-${repetition}`);
          const target = { digest: profileDigest(body), body };
          targets.set(repetition, target);
          additions.push(target);
        }
        await insertProfiles(additions);
      },
      warmup: (growth, _scale, repetition) => read(growth, repetition),
      operation: (growth, _scale, repetition) => read(growth, repetition),
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  } finally {
    await database.admin.query('TRUNCATE presentation.profile_activation, presentation.profile');
    if (contextIds.length > 0)
      await database.admin.query('DELETE FROM semantic.context WHERE context_id = ANY($1::uuid[])', [contextIds]);
  }
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  await database.admin.query(
    `INSERT INTO semantic.context (route, context_id, kind, labels, defaults, recorded_transaction_id)
     VALUES (0, $1, 'global', '{"en":"Global"}'::jsonb, '{}'::jsonb, $2)
     ON CONFLICT (route, context_id) DO NOTHING`,
    [GLOBAL_CONTEXT, newId(0)],
  );
  kernel = createKernel({
    pool: database.pool,
    receiptKeys: testReceiptKeys(),
    requestDeadlineMs: 30_000,
    routeKey,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
});

afterAll(async () => {
  await database?.close();
});

test('Profile routes stay within their bound with Global Context authorization as profiles grow', async () => {
  await checkRouteGrowth('profile');
  await checkRouteGrowth('active-profile');
}, 600_000);
