import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import * as commerceStore from '../../src/commerce/store.ts';
import { StripeUnavailableError, type Offer } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { derivedId, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { readSubjectSummaries } from '../../src/semantic/summaries.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const actions = ['offer:create', 'offer:read', 'offer:manage', 'order:create', 'subject:read'];
const growthActorId = newId(0);
const actorRoute = routeOf(growthActorId)!;
const actorPartition = partitionOf(actorRoute);
const idNamespace = '00000000-0000-8000-8000-000000000001';
const rowsPerScale = 500;
const unrelatedSubjectsPerScale = 256;
const maxScaleUnits = 16;
const operationsPerCheck = 3 * (1 + 5);
// Anchors and measured runs add a few rows beside the seed; four per run bounds them and stays far below one unit.
const rowsOutsideSeed = 4 * operationsPerCheck;
const positionStride = 1_000;
const seedTimestamp = new Date('2026-01-01T00:00:00.000Z');
const activeRange = '[2020-01-01 00:00:00+00,)';
const successUrl = 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}';
const cancelUrl = 'https://web.example.test/checkout/cancel';

let db: GrowthDatabase | undefined;
let fake: ReturnType<typeof startFakeStripe> | undefined;
let access: ReturnType<typeof createAccess>;
let commands: ReturnType<typeof createCommerceCommands>;
let stripe: ReturnType<typeof createStripePort>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let nextPositionBase: number;
let summaryTargetSubjectId: string;

function seededId(name: string, ordinal: number, label: string): string {
  return derivedId(idNamespace, `${name}:${ordinal}:${label}`, actorRoute);
}

function requestKey(family: string, repetition: number): string {
  return `${family}:${repetition}:${Bun.randomUUIDv7()}`;
}

async function freshActor() {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    client_id: 'growth-test',
    scope: actions.join(' '),
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'commerce-growth', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(growthActorId)
    .setIssuedAt(now)
    .setExpirationTime(now + 240)
    .sign(signing.privateKey);
  return access.authenticate(token, { pool: db!.pool, deadline: Date.now() + 5_000 });
}

function offerInput(targetSubjectId = newId(actorRoute)) {
  return {
    targetSubjectId,
    title: 'Growth offer',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
}

async function createOfferAnchor(targetSubjectId?: string): Promise<Offer> {
  return (
    await commands.createOffer(await freshActor(), offerInput(targetSubjectId), requestKey('growth-anchor-offer', 0))
  ).value;
}

async function summaryFor(actor: Awaited<ReturnType<typeof freshActor>>, subjectId: string) {
  const summaries = await readSubjectSummaries(
    { routeKey: new Uint8Array(32).fill(1), pool: db!.pool, access, actor, deadline: Date.now() + 5_000 },
    [subjectId],
  );
  const summary = summaries.get(subjectId);
  if (!summary) throw new Error(`Subject summary ${subjectId} is unavailable`);
  return summary;
}

type PopulationOptions = {
  readonly orders?: boolean;
  readonly entitlements?: boolean;
  readonly receiptKind?: 'offer' | 'checkout';
  readonly transactionsPerOrder?: number;
  readonly offerInitialization?: boolean;
};

let populationNumber = 0;
function commercePopulation(name: string, options: PopulationOptions = {}): Population {
  if (options.entitlements && !options.orders) throw new TypeError('Entitlement rows need their order rows');
  if ((options.transactionsPerOrder ?? 0) > 0 && !options.orders)
    throw new TypeError('Transaction rows need their order rows');
  const positionBase = nextPositionBase + populationNumber++ * 10_000_000_000;

  // Each ordinal follows the production offer, grant initialization and command-envelope row shapes; optional order history is buyer-anchored.
  return {
    name,
    hotPartition: actorPartition,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const offerId = seededId(name, ordinal, 'offer');
      const targetSubjectId = seededId(name, ordinal, 'target');
      const decoyAccountId = seededId(name, ordinal, 'account');
      const commandTransactionId = seededId(name, ordinal, 'command-transaction');
      const initializationTransactionId =
        options.offerInitialization === false
          ? commandTransactionId
          : seededId(name, ordinal, 'initialization-transaction');
      const createdAt = new Date(seedTimestamp.getTime() + ordinal * 1_000);
      const position = positionBase + ordinal * positionStride;
      const commandKind = options.receiptKind === 'checkout' ? 'commerce.checkout.record' : 'commerce.offer.create';
      const orderId = options.orders ? seededId(name, ordinal, 'order') : undefined;
      const idempotencyKey =
        options.receiptKind === 'checkout' && orderId ? `order:${orderId}:checkout:0` : `${name}:${ordinal}`;
      const digest = new Uint8Array(32).fill((ordinal % 254) + 1);
      const offerValue = {
        id: offerId,
        creatorAccountId: growthActorId,
        targetSubjectId,
        title: 'Growth offer',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
        royaltyBasisPoints: 9000,
        state: 'active',
        revision: 1,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      };
      const orderValue = orderId
        ? {
            id: orderId,
            buyerAccountId: growthActorId,
            offerId,
            offerRevision: 1,
            targetSubjectId,
            creatorAccountId: growthActorId,
            title: 'Growth offer',
            currency: 'usd',
            unitAmountMinor: 1200,
            taxCode: 'txcd_10302000',
            royaltyBasisPoints: 9000,
            settlement: options.entitlements ? 'paid' : 'pending',
            checkoutSessionId: options.entitlements ? `cs_test_growth${ordinal}` : null,
            checkoutUrl: options.entitlements ? `https://checkout.example.test/${orderId}` : null,
            checkoutExpiresAt: options.entitlements ? new Date(createdAt.getTime() + 3_600_000).toISOString() : null,
            paymentIntentId: null,
            observedAt: null,
            createdAt: createdAt.toISOString(),
            updatedAt: createdAt.toISOString(),
            revision: options.entitlements ? 3 : 1,
            amountTaxMinor: options.entitlements ? 0 : null,
          }
        : undefined;
      const responseValue = options.receiptKind === 'checkout' ? orderValue : offerValue;
      const receipt = {
        partition_no: actorPartition,
        principal_kind: 'account',
        principal_id: growthActorId,
        command_kind: commandKind,
        idempotency_key: idempotencyKey,
        request_digest: digest,
        epoch: 1,
        position,
        transaction_id: commandTransactionId,
        response: {
          principal: { kind: 'account', id: growthActorId },
          kind: commandKind,
          key: idempotencyKey,
          digest: Buffer.from(digest).toString('base64'),
          response: responseValue,
        },
      };
      const eventType =
        options.receiptKind === 'checkout'
          ? 'com.rezics.commerce.order.updated.v1'
          : 'com.rezics.commerce.offer.created.v1';
      const eventSubject = options.receiptKind === 'checkout' && orderId ? orderId : offerId;
      const eventData = options.receiptKind === 'checkout' && orderId ? { orderId, revision: 2 } : { offerId };

      const rows: Record<string, readonly Record<string, unknown>[]> = {
        'access.account': [
          {
            route: actorRoute,
            account_id: decoyAccountId,
            kind: 'actor',
            state: 'active',
            transaction_id: growthActorId,
          },
        ],
        'access.resource_grant': [
          {
            route: actorRoute,
            resource_id: offerId,
            subject_id: growthActorId,
            subject_role: '',
            action: 'offer:create',
            valid: activeRange,
            transaction_id: commandTransactionId,
            subject_kind: 'identity',
          },
        ],
        'access.resource_denial': [
          {
            route: actorRoute,
            resource_id: offerId,
            subject_id: growthActorId,
            subject_role: '',
            action: 'offer:create',
            reason: 'resource',
            valid: activeRange,
            transaction_id: commandTransactionId,
          },
        ],
        'access.resource_role_grant':
          options.offerInitialization === false
            ? [
                {
                  route: actorRoute,
                  resource_id: offerId,
                  subject_kind: 'identity',
                  subject_id: growthActorId,
                  subject_role: '',
                  grant_role: 'commerce.offer.owner',
                  valid: activeRange,
                  transaction_id: initializationTransactionId,
                },
              ]
            : [
                {
                  route: actorRoute,
                  resource_id: offerId,
                  subject_kind: 'active_accounts',
                  subject_id: '00000000-0000-0000-0000-000000000000',
                  subject_role: '',
                  grant_role: 'commerce.offer.standing',
                  valid: activeRange,
                  transaction_id: initializationTransactionId,
                },
                {
                  route: actorRoute,
                  resource_id: offerId,
                  subject_kind: 'identity',
                  subject_id: growthActorId,
                  subject_role: '',
                  grant_role: 'commerce.offer.owner',
                  valid: activeRange,
                  transaction_id: initializationTransactionId,
                },
              ],
        'core.receipt': [receipt],
        'core.outbox': [
          {
            partition_no: actorPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: seededId(name, ordinal, 'event'),
            type: eventType,
            subject: eventSubject,
            data: eventData,
            recorded_at: createdAt,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: actorPartition,
            transaction_id: commandTransactionId,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: growthActorId,
            client_id: 'growth-test',
            requested_by: null,
            recorded_at: createdAt,
          },
        ],
        'commerce.offer': [
          {
            route: actorRoute,
            offer_id: offerId,
            creator_account_id: growthActorId,
            target_subject_id: targetSubjectId,
            title: 'Growth offer',
            currency: 'usd',
            unit_amount_minor: 1200,
            tax_code: 'txcd_10302000',
            royalty_basis_points: 9000,
            state: 'active',
            revision: 1,
            created_at: createdAt,
            updated_at: createdAt,
            transaction_id: commandTransactionId,
          },
        ],
      };

      if (options.offerInitialization !== false) {
        rows['access.resource_initialization'] = [
          {
            route: actorRoute,
            resource_id: offerId,
            resource_type: 'commerce.offer',
            creator_id: growthActorId,
            initialized_at: createdAt,
          },
        ];
      }

      if (orderId && orderValue) {
        const paidSessionId = options.entitlements ? `cs_test_growth${ordinal}` : null;
        rows['commerce.purchase_order'] = [
          {
            route: actorRoute,
            order_id: orderId,
            buyer_account_id: growthActorId,
            offer_id: offerId,
            offer_revision: 1,
            target_subject_id: targetSubjectId,
            creator_account_id: growthActorId,
            title: 'Growth offer',
            currency: 'usd',
            unit_amount_minor: 1200,
            tax_code: 'txcd_10302000',
            royalty_basis_points: 9000,
            settlement: orderValue.settlement,
            checkout_session_id: paidSessionId,
            checkout_url: orderValue.checkoutUrl,
            checkout_expires_at: orderValue.checkoutExpiresAt,
            payment_intent_id: null,
            observed_at: null,
            created_at: createdAt,
            updated_at: createdAt,
            revision: orderValue.revision,
            transaction_id: seededId(name, ordinal, 'order-transaction'),
            amount_tax_minor: orderValue.amountTaxMinor,
          },
        ];
        if (options.entitlements) {
          rows['commerce.entitlement'] = [
            {
              route: actorRoute,
              entitlement_id: seededId(name, ordinal, 'entitlement'),
              account_id: growthActorId,
              order_id: orderId,
              offer_id: offerId,
              target_subject_id: targetSubjectId,
              granted_at: createdAt,
              revoked_at: null,
              revoke_reason: null,
              revision: 1,
              transaction_id: seededId(name, ordinal, 'entitlement-transaction'),
            },
          ];
        }
        if ((options.transactionsPerOrder ?? 0) > 0) {
          rows['commerce.order_transaction'] = Array.from({ length: options.transactionsPerOrder! }, (_, index) => {
            const amount = index === 0 ? 1200 : -1;
            const fee = index === 0 ? 60 : 0;
            return {
              route: actorRoute,
              order_id: orderId,
              balance_transaction_id: `txn_growth${ordinal}x${index}`,
              kind: index === 0 ? 'charge' : 'refund',
              source_id: index === 0 ? `ch_growth${ordinal}` : `re_growth${ordinal}_${index}`,
              currency: 'usd',
              amount_minor: amount,
              fee_minor: fee,
              net_minor: amount - fee,
              fee_details: [],
              exchange_rate: null,
              stripe_created: createdAt,
              recorded_at: createdAt,
              transaction_id: seededId(name, ordinal, `order-transaction-${index}`),
            };
          });
        }
      }

      return rows;
    },
    finish: async (admin, range) => {
      if (range.to === range.from) return;
      const lastPosition = positionBase + (range.to - 1) * positionStride;
      await admin.query('UPDATE core.partition SET position = GREATEST(position, $2) WHERE partition_no = $1', [
        actorPartition,
        lastPosition,
      ]);
    },
  };
}

function unrelatedSubjectPopulation(name: string): Population {
  return {
    name,
    hotPartition: actorPartition,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'semantic.subject': [
        {
          route: actorRoute,
          subject_id: seededId(name, ordinal, 'unrelated-subject'),
          type: 'schema:Book',
          recorded_transaction_id: seededId(name, ordinal, 'unrelated-subject-transaction'),
          visibility: 'visible',
          security_revision: 0,
          current_facts: 0,
          current_release: bundledDigest,
        },
      ],
    }),
  };
}

async function grow(
  database: GrowthDatabase,
  population: Population,
  scale: number,
  previous: number,
  perScale = rowsPerScale,
) {
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: previous * perScale,
    to: scale * perScale,
  });
}

async function resetGrowthData(database: GrowthDatabase) {
  // The check database has a 1 GiB tmpfs; recycle migration and prior-check WAL before each population.
  await database.admin.query('CHECKPOINT');
  await database.admin.query(`
    TRUNCATE commerce.order_transaction, commerce.entitlement, commerce.purchase_order, commerce.offer,
      access.resource_role_grant, access.resource_initialization, access.resource_grant, access.resource_denial,
      core.receipt, core.outbox, editorial.write_basis
  `);
  await database.admin.query(
    'DELETE FROM access.account WHERE route = $1 AND transaction_id = $2 AND account_id <> $2',
    [actorRoute, growthActorId],
  );
  await database.admin.query(
    "INSERT INTO access.resource_grant(route, resource_id, subject_id, subject_role, action, valid, transaction_id, subject_kind) VALUES (0, $1, $2, '', 'offer:create', '(,)', $2, 'identity')",
    [GLOBAL_CONTEXT, growthActorId],
  );
}

type SeedAudit = { readonly name: string; readonly counts: ReadonlyMap<string, { rows: number; allowed: number }> };
const seedAudits: SeedAudit[] = [];

async function auditSeededRows(
  database: GrowthDatabase,
  name: string,
  population: Population,
  baseline: ReadonlyMap<string, number>,
  perScale: number,
) {
  const perOrdinal = population.rows!(placement(population, 0));
  const counts = new Map<string, { rows: number; allowed: number }>();
  for (const [relation, rows] of Object.entries(perOrdinal)) {
    const { rows: found } = await database.admin.query(`SELECT count(*)::int AS rows FROM ${relation}`);
    counts.set(relation, {
      rows: found[0].rows,
      allowed: (baseline.get(relation) ?? 0) + maxScaleUnits * perScale * rows.length + rowsOutsideSeed,
    });
  }
  seedAudits.push({ name, counts });
}

async function check(
  database: GrowthDatabase,
  name: string,
  population: Population,
  operation: GrowthCheck['operation'],
  unrelatedSubjects?: Population,
) {
  const populations = [population, ...(unrelatedSubjects ? [unrelatedSubjects] : [])];
  const baselines = new Map<Population, Map<string, number>>();
  for (const current of populations) {
    const relations = Object.keys(current.rows!(placement(current, 0)));
    const baseline = new Map<string, number>();
    for (const relation of relations) {
      const { rows } = await database.admin.query(`SELECT count(*)::int AS rows FROM ${relation}`);
      baseline.set(relation, rows[0].rows);
    }
    baselines.set(current, baseline);
  }
  const report = await checkGrowth(database, {
    name,
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      for (const current of populations)
        await grow(
          growthDb,
          current,
          scale,
          previous,
          current === unrelatedSubjects ? unrelatedSubjectsPerScale : rowsPerScale,
        );
    },
    operation,
  });
  for (const current of populations)
    await auditSeededRows(
      database,
      name,
      current,
      baselines.get(current)!,
      current === unrelatedSubjects ? unrelatedSubjectsPerScale : rowsPerScale,
    );
  return report;
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  db.pool.options.max = 1;
  fake = startFakeStripe();
  stripe = createStripePort({
    apiKey: 'sk_test_growth_fixture',
    managedPayments: false,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    timeoutMs: 1000,
    maxNetworkRetries: 0,
    clock: () => new Date(),
  });
  const entropy = Number.parseInt(Bun.randomUUIDv7().replaceAll('-', '').slice(0, 7), 16);
  nextPositionBase = 1_000_000_000_000 + entropy * 20_000_000;

  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'commerce-growth', alg: 'ES256' };
  access = createAccess({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: action === 'subject:read',
          ...(action === 'offer:create' ? { 'x-resource-types': ['commerce.offer'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  commands = createCommerceCommands({ pool: db.pool, access });

  await db.admin.query(
    "INSERT INTO access.account(route, account_id, kind, state, transaction_id) VALUES ($1, $2, 'actor', 'active', $2)",
    [actorRoute, growthActorId],
  );
  await db.admin.query(
    "INSERT INTO access.resource_grant(route, resource_id, subject_id, subject_role, action, valid, transaction_id, subject_kind) VALUES (0, $1, $2, '', 'offer:create', '(,)', $2, 'identity')",
    [GLOBAL_CONTEXT, growthActorId],
  );
  await bootstrapRelease(db.pool, bundledRelease);
  const subjectKey = requestKey('growth-summary-subject', 0);
  summaryTargetSubjectId = (
    await createSubject(db.pool, {
      actor: {
        kind: 'account',
        accountId: growthActorId,
        clientId: 'growth-test',
        scopes: [...actions],
        requestedBy: null,
        authnEpoch: 1,
      },
      target: { route: actorRoute, id: newId(actorRoute) },
      idempotencyKey: subjectKey,
      digest: createHash('sha256').update(subjectKey).digest(),
      item: { type: 'schema:Book', labels: { en: 'Growth target', ja: '成長対象' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
});

afterAll(async () => {
  fake?.stop();
  await db?.close();
});

test('Command envelope stays within its bound as P grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  await createOfferAnchor();
  const population = commercePopulation(`command-envelope-${Bun.randomUUIDv7()}`);
  await check(database, 'Command envelope stays within its bound as P grows', population, async (_, __, repetition) =>
    commands.createOffer(await freshActor(), offerInput(), requestKey('command-envelope', repetition)),
  );
}, 90_000);

test('Authorization stays within its bound as P grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  await createOfferAnchor();
  const population = commercePopulation(`authorization-${Bun.randomUUIDv7()}`);
  await check(database, 'Authorization stays within its bound as P grows', population, async (_, __, repetition) =>
    commands.createOffer(await freshActor(), offerInput(), requestKey('authorization', repetition)),
  );
}, 90_000);

test('Offer creation stays within its bound as N grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  await createOfferAnchor();
  const population = commercePopulation(`offer-creation-${Bun.randomUUIDv7()}`);
  await check(database, 'Offer creation stays within its bound as N grows', population, async (_, __, repetition) =>
    commands.createOffer(await freshActor(), offerInput(), requestKey('offer-creation', repetition)),
  );
}, 90_000);

test('Offer read and delist stays within its bound as N grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offers: Offer[] = [];
  for (let index = 0; index < operationsPerCheck; index++) offers.push(await createOfferAnchor(summaryTargetSubjectId));
  const population = commercePopulation(`offer-read-delist-${Bun.randomUUIDv7()}`, {
    orders: true,
    entitlements: true,
    offerInitialization: false,
  });
  const report = await check(
    database,
    'Offer read and delist stays within its bound as N grows',
    population,
    async (_, __, repetition) => {
      const offer = offers[repetition];
      if (!offer) throw new Error(`Missing offer for repetition ${repetition}`);
      const actor = await freshActor();
      const read = await commands.readOffer(offer.id);
      if (!read) throw new Error(`Offer ${offer.id} is missing`);
      const subject = await summaryFor(actor, read.targetSubjectId);
      expect(subject.id).toBe(summaryTargetSubjectId);
      return commands.delistOffer(actor, offer.id, requestKey('offer-delist', repetition));
    },
    unrelatedSubjectPopulation(`offer-read-subjects-${Bun.randomUUIDv7()}`),
  );
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
  ]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
  ]);
}, 90_000);

test('Order creation stays within its bound as o grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const population = commercePopulation(`order-creation-${Bun.randomUUIDv7()}`, {
    orders: true,
    offerInitialization: false,
  });
  await check(database, 'Order creation stays within its bound as o grows', population, async (_, __, repetition) =>
    commands.createOrder(await freshActor(), offer.id, requestKey('order-creation', repetition)),
  );
}, 90_000);

test('Checkout and receipt recording stays within its bound as o grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const population = commercePopulation(`checkout-${Bun.randomUUIDv7()}`, {
    orders: true,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  await check(
    database,
    'Checkout and receipt recording stays within its bound as o grows',
    population,
    async (_, __, repetition) => {
      const actor = await freshActor();
      const key = requestKey('checkout', repetition);
      fake!.nextCreateFault = 'lost';
      try {
        await checkout({ pool: database.pool, commands, stripe, successUrl, cancelUrl }, actor, offer.id, key);
        throw new Error('The first Stripe result should be unavailable');
      } catch (error) {
        expect(error).toBeInstanceOf(StripeUnavailableError);
      }
      const completed = await checkout(
        { pool: database.pool, commands, stripe, successUrl, cancelUrl },
        await freshActor(),
        offer.id,
        key,
      );
      expect(completed.checkoutSessionId).toMatch(/^cs_test_/);
      return completed;
    },
  );
}, 90_000);

test('Order session and transaction reads stays within its bound as o grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor(summaryTargetSubjectId);
  const actor = await freshActor();
  const anchor = await checkout(
    { pool: database.pool, commands, stripe, successUrl, cancelUrl },
    actor,
    offer.id,
    requestKey('order-read-anchor', 0),
  );
  const population = commercePopulation(`order-reads-${Bun.randomUUIDv7()}`, {
    orders: true,
    transactionsPerOrder: 8,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  const report = await check(
    database,
    'Order session and transaction reads stays within its bound as o grows',
    population,
    async () => {
      const primaryOrder = await commerceStore.readOrder(database.pool, actorRoute, anchor.id);
      if (!primaryOrder) throw new Error(`Order ${anchor.id} is missing`);
      const actor = await freshActor();
      const subject = await summaryFor(actor, primaryOrder.targetSubjectId);
      expect(subject.id).toBe(summaryTargetSubjectId);
      const sessionOrder = await commerceStore.readOrderBySession(database.pool, actorRoute, anchor.checkoutSessionId!);
      const transactions = await commerceStore.readOrderTransactions(database.pool, actorRoute, anchor.id);
      expect(sessionOrder?.id).toBe(anchor.id);
      expect(transactions).toHaveLength(0);
      return { primaryOrder, subject, sessionOrder, transactions };
    },
    unrelatedSubjectPopulation(`order-read-subjects-${Bun.randomUUIDv7()}`),
  );
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
  ]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
  ]);
}, 90_000);

test('Order decision and settlement stays within its bound as N grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const anchor = await checkout(
    { pool: database.pool, commands, stripe, successUrl, cancelUrl },
    await freshActor(),
    offer.id,
    requestKey('settlement-anchor', 0),
  );
  const population = commercePopulation(`order-settlement-${Bun.randomUUIDv7()}`, {
    orders: true,
    entitlements: true,
    transactionsPerOrder: 8,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  await check(
    database,
    'Order decision and settlement stays within its bound as N grows',
    population,
    async (_, __, repetition) => {
      const order = await commerceStore.readOrder(database.pool, actorRoute, anchor.id);
      if (!order) throw new Error('Settlement anchor order is missing');
      return commands.applyCheckoutSnapshot(
        {
          sessionId: anchor.checkoutSessionId!,
          clientReferenceId: order.id,
          metadataOrderId: order.id,
          status: 'complete',
          paymentStatus: 'paid',
          paymentIntentStatus: 'succeeded',
          paymentIntentId: 'pi_growthsettlementanchor',
          livemode: false,
          currency: order.currency,
          amountSubtotalMinor: order.unitAmountMinor,
          amountTotalMinor: order.unitAmountMinor,
          amountTaxMinor: 0,
          chargeAmountMinor: order.unitAmountMinor,
          chargeId: 'ch_growthsettlementanchor',
          refunds: [],
          disputes: [],
          transactions: [],
          observedAt: new Date().toISOString(),
        },
        requestKey('settlement-workflow', repetition),
      );
    },
  );
}, 90_000);

test('Entitlement grant change lock and read stays within its bound as e grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const created = await commands.createOrder(await freshActor(), offer.id, requestKey('entitlement-anchor', 0));
  const population = commercePopulation(`entitlement-lock-${Bun.randomUUIDv7()}`, {
    orders: true,
    entitlements: true,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  await check(
    database,
    'Entitlement grant change lock and read stays within its bound as e grows',
    population,
    async () => {
      const state = await commerceStore.readSettlementState(database.pool, actorRoute, created.value.id, []);
      expect(state?.entitlement).toBeNull();
      return state;
    },
  );
}, 90_000);

test('Entitlement list stays within its bound as d grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const anchor = await commands.createOrder(await freshActor(), offer.id, requestKey('entitlement-list-anchor', 0));
  const population = commercePopulation(`entitlement-list-${Bun.randomUUIDv7()}`, {
    orders: true,
    entitlements: true,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  await check(database, 'Entitlement list stays within its bound as d grows', population, async () =>
    commerceStore.listEntitlements(database.pool, actorRoute, growthActorId, { after: null, limit: 20 }),
  );
  expect(anchor.value.id).toBeTruthy();
}, 90_000);

test('Webhook and commerce jobs stays within its bound as N grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const anchor = await checkout(
    { pool: database.pool, commands, stripe, successUrl, cancelUrl },
    await freshActor(),
    offer.id,
    requestKey('commerce-job-anchor', 0),
  );
  const population = commercePopulation(`commerce-jobs-${Bun.randomUUIDv7()}`, {
    orders: true,
    entitlements: true,
    transactionsPerOrder: 8,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  await check(
    database,
    'Webhook and commerce jobs stays within its bound as N grows',
    population,
    async (_, __, repetition) =>
      commands.readOrderForAccount(growthActorId, anchor.id).then((order) => {
        if (!order) throw new Error('Commerce job anchor order is missing');
        return order;
      }),
  );
}, 90_000);

test('Erasure stays within its bound as N grows', async () => {
  const database = db!;
  await resetGrowthData(database);
  const offer = await createOfferAnchor();
  const erasureOrder = await checkout(
    { pool: database.pool, commands, stripe, successUrl, cancelUrl },
    await freshActor(),
    offer.id,
    requestKey('erasure-transaction-anchor', 0),
  );
  await commands.applyCheckoutSnapshot(
    {
      sessionId: erasureOrder.checkoutSessionId!,
      clientReferenceId: erasureOrder.id,
      metadataOrderId: erasureOrder.id,
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntentStatus: 'succeeded',
      paymentIntentId: 'pi_growtherasureanchor',
      livemode: false,
      currency: 'usd',
      amountSubtotalMinor: 1200,
      amountTotalMinor: 1200,
      amountTaxMinor: 0,
      chargeAmountMinor: 1200,
      chargeId: 'ch_growthErasureAnchor',
      refunds: [],
      disputes: [],
      transactions: [
        {
          id: 'txn_growthErasureAnchor',
          kind: 'charge',
          sourceId: 'ch_growthErasureAnchor',
          currency: 'usd',
          amountMinor: 1200,
          feeMinor: 0,
          netMinor: 1200,
          feeDetails: [],
          exchangeRate: null,
          created: new Date().toISOString(),
        },
      ],
      observedAt: new Date().toISOString(),
    },
    requestKey('erasure-settlement', 0),
  );
  const population = commercePopulation(`erasure-${Bun.randomUUIDv7()}`, {
    orders: true,
    transactionsPerOrder: 8,
    receiptKind: 'checkout',
    offerInitialization: false,
  });
  await check(database, 'Erasure stays within its bound as N grows', population, async () => {
    await expect(
      database.pool.query(
        'DELETE FROM commerce.order_transaction WHERE route = $1 AND order_id = $2 AND balance_transaction_id = $3',
        [actorRoute, erasureOrder.id, 'txn_growthErasureAnchor'],
      ),
    ).rejects.toThrow();
  });
}, 90_000);

test('every growth-orders check seeds at most sixteen scale units', () => {
  expect(seedAudits.length).toBeGreaterThan(0);
  const excess = seedAudits.flatMap(({ name, counts }) =>
    [...counts]
      .filter(([, { rows, allowed }]) => rows > allowed)
      .map(([relation, { rows, allowed }]) => `${name}: ${relation} holds ${rows} rows, at most ${allowed} allowed`),
  );
  expect(excess).toEqual([]);
});
