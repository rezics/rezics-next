import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import type { Pool } from 'pg';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import {
  createResourceCreationManifest,
  parentCreationAuthorization,
} from '../../src/access/index.ts';
import { currentCommand, type CommandTransaction } from '../../src/command/command.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { revisionResource } from '../../src/semantic/authorship.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import type { Resource } from '../../src/request/access.ts';
import {
  completeAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
  unmergeVerifiedAgent,
  removeAgentVerificationPage,
  finishAgentVerificationReversal,
  type AgentVerificationReversal,
} from '../../src/access/agent-verification.ts';
import { applyAccountAgentEffect } from '../../src/access/account-agent-effect.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { accountToken, admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const accountRoute = 0x5274;
const catalogueRoute = 0x6573;
const routeKey = new Uint8Array(32).fill(31);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(32)]]) };
const receiptKeys = testReceiptKeys();
const clock = () => new Date();
const links = [{ label: 'Website', url: 'https://example.test/profile' }];
type Seeded = { id: string; handle: string; kind: 'actor' | 'organization'; displayName: string };
let db: GrowthDatabase;
let pool: Pool;
let access: ReturnType<typeof admittedAccess>;
let kernel: ReturnType<typeof createKernel>;
let staff: Seeded;
let manager: Seeded;
const node = (type: string, id: string) => ({ type, props: { id } });
const document = {
  root: { props: {} },
  content: [node('SubjectHeader', 'header'), node('AccountIdentity', 'identity')],
};
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: document,
  bases: [],
  types: ['schema:Organization', 'schema:Person', 'schema:SoftwareApplication'].map((type) => ({
    type,
    views: { overview: document, details: document },
  })),
  routes: [],
};

async function drain() {
  const projection = linkProjection(pool);
  for (let round = 0; round < 50; round++) {
    let progressed = false;
    for (const partition of [0, partitionOf(accountRoute), partitionOf(catalogueRoute)]) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await projection.run(partition);
        if (result.status !== 'read' || result.envelopes === 0) break;
        progressed = true;
        if (attempt === 49) throw new Error('Semantic link projection did not drain');
      }
    }
    // Merge projection can emit events back into a partition already drained in this round.
    if (!progressed) return;
  }
  throw new Error('Semantic link projection did not reach quiescence');
}

function key(): string {
  return randomUUID();
}

async function seedAccount(
  handle: string,
  options: { kind?: 'actor' | 'organization'; automatedBy?: string } = {},
): Promise<Seeded> {
  const id = newId(accountRoute);
  const kind = options.kind ?? 'actor';
  const displayName = handle.replaceAll('_', ' ');
  await pool.query(
    `INSERT INTO access.account
      (route, account_id, kind, handle, display_name, state, operator_account_id, transaction_id)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $2)`,
    [accountRoute, id, kind, handle, displayName, options.automatedBy ?? null],
  );
  if (kind === 'actor') {
    await pool.query(
      `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
       VALUES ($1, $2, $2, 'account:update', '(,)', $2),
              ($1, $2, $2, 'account:read', '(,)', $2)`,
      [accountRoute, id],
    );
  }
  const handleRoute = createHash('sha256').update(handle).digest().readUInt16BE(0);
  await pool.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     VALUES($1,$2,$3,'active',$3)`,
    [handleRoute, handle, id],
  );
  return { id, handle, kind, displayName };
}

async function bearer(
  account: Seeded,
  scopes = [...actionCatalogue(kernel).keys(), 'account:manage', 'gate:any'],
): Promise<string> {
  return accountToken({ accountId: account.id, clientId: 'agent-verification-test', scopes });
}

async function request(
  account: Seeded,
  subject: string,
  token: string,
  body: { statement?: string; links?: typeof links } = {},
) {
  return post(`/v1/accounts/${account.id}:requestVerification`, token, {
    subject,
    statement: body.statement ?? `I represent ${account.handle}`,
    links: body.links ?? links,
  });
}

async function get(path: string, token?: string) {
  const response = await kernel.handle(
    new Request(`https://kernel.test${path}`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function post(path: string, token: string | undefined, body?: unknown, idempotencyKey = key()) {
  const headers: Record<string, string> = { [IDEMPOTENCY_HEADER]: JSON.stringify(idempotencyKey) };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await kernel.handle(new Request(`https://kernel.test${path}`, init));
  return { response, body: (await response.json()) as Record<string, any> };
}

async function catalogueSubject(type: 'schema:Person' | 'schema:Organization', label: string): Promise<string> {
  const created = await post('/v1/subjects', await bearer(staff), { type, labels: { en: label } });
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  await drain();
  return created.body.subject.id as string;
}

function nativeCreationEntry(
  resource: Resource,
  type: string,
  accountId: string,
  subject: string,
  revision: number,
) {
  return {
    resource,
    type,
    creator: accountId,
    creation: {
      async validate(client: CommandTransaction, candidate: Readonly<Resource>): Promise<boolean> {
        const command = currentCommand(client);
        if (
          candidate.route !== resource.route ||
          candidate.id !== resource.id ||
          command.basis?.actorAccountId !== accountId ||
          command.authorization?.mode !== 'execute'
        )
          return false;
        if (type === 'semantic.subject') {
          const result = await client.query(
            `SELECT 1 FROM semantic.subject s
             JOIN semantic.revision r ON r.route=s.route AND r.subject_id=s.subject_id AND r.revision=1
               AND r.recorded_transaction_id=s.recorded_transaction_id AND r.kind='create'
             WHERE s.route=$1 AND s.subject_id=$2 AND s.recorded_transaction_id=$3::uuid`,
            [resource.route, subject, command.transactionId],
          );
          return result.rows.length === 1;
        }
        const result = await client.query(
          `SELECT 1 FROM semantic.revision r
           WHERE r.route=$1 AND r.subject_id=$2 AND r.revision=$3
             AND r.kind IN ('create','propose','terms') AND r.recorded_transaction_id=$4::uuid`,
          [resource.route, subject, revision, command.transactionId],
        );
        return result.rows.length === 1;
      },
    },
  };
}

async function ensureAgent(account: Seeded, kind: 'person' | 'organization'): Promise<void> {
  const agentId = accountAgentId(account.id);
  const route = routeOf(agentId)!;
  const target = { route, id: agentId };
  const deadline = Date.now() + 30_000;
  const actor = await authenticateAccount(
    access,
    { pool, deadline },
    {
      accountId: staff.id,
      clientId: 'agent-verification-test',
      scopes: ['subject:create'],
    },
  );
  const firstRevision = revisionResource(target.id, 1);
  const subjectEntry = nativeCreationEntry(target, 'semantic.subject', actor.accountId, target.id, 1);
  const authorization = parentCreationAuthorization({
    access,
    actor,
    action: 'subject:create',
    parent: globalContextAnchor,
    context: {
      pool,
      deadline,
      resource: target,
      creation: subjectEntry.creation,
      manifest: createResourceCreationManifest([
        subjectEntry,
        nativeCreationEntry(firstRevision, 'semantic.revision', actor.accountId, target.id, 1),
      ]),
    },
  });
  await createSubject(pool, {
    actor,
    target,
    idempotencyKey: key(),
    digest: createHash('sha256').update(key()).digest(),
    item: {
      type: kind === 'person' ? 'schema:Person' : 'schema:Organization',
      labels: { en: account.displayName },
    },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization,
    deadline,
    clock,
  });
  await pool.query(
    `INSERT INTO semantic.account_agent_subject (route, account_route, subject_id, account_id, agent_id)
     VALUES ($1, $1, $2, $3, $2)
     ON CONFLICT (route, subject_id) DO NOTHING`,
    [route, agentId, account.id],
  );
  await drain();
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  pool = db.pool;
  configureTestReceiptKeys(pool);
  await bootstrapRelease(pool, bundledRelease);
  await bootstrapProfile(pool, profile);
  const initial = createKernel({ pool, routeKey, tokens, receiptKeys, clock });
  const actions = new Map(actionCatalogue(initial));
  for (const [action, value] of LIFECYCLE_ACTIONS) actions.set(action, value);
  actions.set('account:manage', { anonymous: false });
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    receiptKeys,
    clock,
    requestDeadlineMs: 30_000,
    access: (config) => (access = admittedAccess({ ...config, actions })),
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  staff = await seedAccount('page_staff');
  manager = await seedAccount('page_manager');
  await bootstrapGovernance(pool, staff.id);
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES (0, $1, $2, 'subject:create', '(,)', $2)
     ON CONFLICT DO NOTHING`,
    [GLOBAL_CONTEXT, staff.id],
  );
  expect((await post('/v1/platform/exposure/agent_verification:open', await bearer(staff))).response.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function verified(kind: 'actor' | 'organization' = 'actor') {
  const account = await seedAccount(`page_${randomUUID().slice(0, 8)}`, { kind });
  if (kind === 'organization')
    await pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,'account:manage','(,)',$3)`,
      [accountRoute, account.id, manager.id],
    );
  const token = await bearer(kind === 'organization' ? manager : account);
  await ensureAgent(account, kind === 'actor' ? 'person' : 'organization');
  const subject = await catalogueSubject(kind === 'actor' ? 'schema:Person' : 'schema:Organization', 'Catalogue');
  const applied = await request(account, subject, token);
  expect(applied.response.status).toBe(201);
  const approved = await post(
    `/v1/verification-requests/${applied.body.verificationRequest.id}:approve`,
    await bearer(staff),
    {},
  );
  expect(approved.response.status).toBe(200);
  const decision = (await readAgentVerificationWorkflowRequest(pool, applied.body.verificationRequest.id))!;
  const workflow = { ...decision, receiptId: decision.decisionReceiptId! };
  await recordPendingAgentVerification(pool, workflow, clock);
  await mergeVerifiedAgent(pool, workflow);
  await writeAgentVerificationPage(pool, workflow);
  await completeAgentVerification(pool, workflow, clock);
  await finishAgentVerification(pool, workflow, clock);
  expect((await get(`/v1/accounts?agent=${subject}`)).body.accounts).toHaveLength(1);
  await drain();
  return { account, subject, token };
}

async function finish(decision: AgentVerificationReversal) {
  await unmergeVerifiedAgent(pool, decision);
  await removeAgentVerificationPage(pool, decision);
  await finishAgentVerificationReversal(pool, decision, clock);
  await drain();
}

async function page(target: Record<string, unknown>, query = '', languages?: string[]) {
  return post(`/v1/pages:read${query}`, undefined, { target, ...(languages ? { languages } : {}) });
}

async function expectSubjectPage(subject: string, view?: string) {
  const answer = await page({ subject, ...(view ? { view } : {}) });
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.response.headers.get('location')).toBeNull();
  expect(answer.body.subject).toBe(subject);
  expect(answer.body).not.toHaveProperty('account');
  expect(JSON.stringify(answer.body)).not.toContain('page_');
  return answer;
}

async function expectRedirect(subject: string, handle: string, view?: string) {
  const target = { subject, ...(view ? { view } : {}) };
  const query = '?locale=zh-Hant&tag=one&tag=two';
  const answer = await page(target, query, ['zh-Hant', 'en']);
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(308);
  expect(answer.body).toEqual({ redirect: { from: subject, to: handle } });
  expect(answer.response.headers.get('content-type')).toBe('application/json');
  const location = new URL(answer.response.headers.get('location')!, 'https://kernel.test');
  expect(location.pathname).toBe('/v1/pages:read');
  expect(location.searchParams.get('locale')).toBe('zh-Hant');
  expect(location.searchParams.getAll('tag')).toEqual(['one', 'two']);
  expect(JSON.parse(location.searchParams.get('target')!)).toEqual({ account: handle, ...(view ? { view } : {}) });
  // A client follows a 308 with the original method/body. The Location replaces only its target.
  const followed = await post(`${location.pathname}${location.search}`, undefined, {
    target,
    languages: ['zh-Hant', 'en'],
  });
  const direct = await page({ account: handle, ...(view ? { view } : {}) }, query, ['zh-Hant', 'en']);
  expect(followed.response.status).toBe(direct.response.status);
  expect(followed.response.status).toBe(200);
  expect(followed.body).toEqual(direct.body);
  expect(followed.response.headers.get('location')).toBeNull();
  return followed;
}

test('a verified person has one handle page; subject reads are unchanged and merged addresses redirect in one step', async () => {
  const { account, subject } = await verified();
  const subjectRead = await get(`/v1/subjects/${subject}?language=en`);
  expect(subjectRead.response.status, JSON.stringify(subjectRead.body)).toBe(200);
  expect(subjectRead.response.headers.get('location')).toBeNull();
  expect(subjectRead.body.subject).toMatchObject({ id: subject, type: 'schema:Person' });
  for (const view of [undefined, 'details']) {
    const followed = await expectRedirect(subject, account.handle, view);
    expect(followed.body).toMatchObject({ subject, account: account.id, template: { key: 'schema:Person' } });
  }
  await expectRedirect(accountAgentId(account.id), account.handle, 'details');
  expect((await get(`/v1/subjects/${subject}?language=en`)).body).toEqual(subjectRead.body);
  const mergedRead = await get(`/v1/subjects/${accountAgentId(account.id)}`);
  expect(mergedRead.response.status).toBe(308);
  expect(mergedRead.body).toEqual({ redirect: { from: accountAgentId(account.id), to: subject } });
});

test("never verified, another account's subject, and pending verification disclose no account page", async () => {
  const account = await seedAccount('page_pending');
  const other = await verified();
  const subject = await catalogueSubject('schema:Person', 'Unverified catalogue person');
  await ensureAgent(account, 'person');
  await expectSubjectPage(subject);
  await drain();
  await expectSubjectPage(accountAgentId(account.id));
  const applied = await request(account, subject, await bearer(account));
  expect(applied.response.status).toBe(201);
  await expectSubjectPage(subject);
  const unrelated = await catalogueSubject('schema:Person', 'Other catalogue person');
  const pageRead = await expectSubjectPage(unrelated);
  expect(JSON.stringify(pageRead.body)).not.toContain(other.account.handle);
  expect(JSON.stringify(pageRead.body)).not.toContain(account.id);
});

for (const reversal of ['releaseVerification', 'revokeVerification'] as const) {
  test(`${reversal} restores the subject page before and after the reversal workflow`, async () => {
    const { account, subject, token } = await verified();
    await expectRedirect(subject, account.handle);
    const reversed = await post(
      `/v1/accounts/${account.id}:${reversal}`,
      reversal === 'releaseVerification' ? token : await bearer(staff),
      {},
    );
    expect(reversed.response.status).toBe(200);
    await expectSubjectPage(subject);
    await finish(reversed.body.reversal);
    const answer = await expectSubjectPage(subject);
    expect(JSON.stringify(answer.body)).not.toContain(account.handle);
    expect((await get(`/v1/subjects/${subject}`)).response.status).toBe(200);
  });
}

test('deletion never redirects or names the old handle, including while the committed reversal runs', async () => {
  const { account, subject } = await verified();
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$2,'account:delete','(,)',$2)`,
    [accountRoute, account.id],
  );
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: account.id,
      clientId: 'page-delete',
      scopes: ['account:delete'],
    },
  );
  await createLifecycleCommands({ pool, access, clock }).tombstone(
    { actor, deadline: Date.now() + 10_000 },
    { accountId: account.id, key: key() },
  );
  const immediate = await expectSubjectPage(subject);
  expect(JSON.stringify(immediate.body)).not.toContain(account.handle);
  const events: CloudEvent[] = [];
  for (
    let page = 0;
    page < 20 && !events.some((e) => e.subject === account.id && e.type === 'com.rezics.access.account-tombstoned.v1');
    page++
  ) {
    await readBatch(pool, {
      consumer: 'page_address_deletion',
      partition: partitionOf(accountRoute),
      envelopes: 64,
      async apply(envelopes) {
        events.push(...envelopes.flatMap((e) => e.events));
      },
    });
  }
  const event = events.find((e) => e.subject === account.id && e.type === 'com.rezics.access.account-tombstoned.v1');
  expect(event).toBeDefined();
  await applyAccountAgentEffect(pool, event!);
  const decision = await pool.query<{ data: AgentVerificationReversal }>(
    'SELECT data FROM core.outbox WHERE type=$1 AND subject=$2',
    ['com.rezics.access.agent-verification.reversing.v1', account.id],
  );
  expect(decision.rows[0]!.data).toMatchObject({ kind: 'revoked', reason: 'Account deleted' });
  await finish(decision.rows[0]!.data);
  const answer = await expectSubjectPage(subject);
  expect(JSON.stringify(answer.body)).not.toContain(account.handle);
  expect((await page({ account: account.handle })).response.status).toBe(404);
});

test('a suspended verified person serves the subject page until reinstatement restores the handle redirect', async () => {
  const { account, subject } = await verified();
  const suspended = await post(`/v1/accounts/${account.id}:suspend`, await bearer(staff), { reason: 'Page test' });
  expect(suspended.response.status).toBe(200);
  for (const view of [undefined, 'details']) {
    const answer = await expectSubjectPage(subject, view);
    expect(JSON.stringify(answer.body)).not.toContain(account.id);
    expect(JSON.stringify(answer.body)).not.toContain(account.handle);
  }
  expect((await get(`/v1/accounts?agent=${subject}`)).body).toEqual({ accounts: [], next: null });
  expect((await get(`/v1/accounts?handle=${account.handle}`)).body.accounts[0]).toMatchObject({
    id: account.id,
    state: 'active',
  });
  const reinstated = await post(`/v1/accounts/${account.id}:reinstate`, await bearer(staff), {});
  expect(reinstated.response.status, JSON.stringify(reinstated.body)).toBe(200);
  for (const view of [undefined, 'details']) {
    const followed = await expectRedirect(subject, account.handle, view);
    expect(followed.body.account).toBe(account.id);
  }
  expect((await get(`/v1/accounts?agent=${subject}`)).body.accounts).toEqual([
    expect.objectContaining({ id: account.id, handle: account.handle, state: 'active' }),
  ]);
});

test('unnamed software, person and organization accounts use their agent templates and public identity fields', async () => {
  const operator = await seedAccount('page_operator');
  const software = await seedAccount('page_software', { automatedBy: operator.id });
  const person = await seedAccount('page_person');
  const organization = await seedAccount('page_organization', { kind: 'organization' });
  for (const [account, type, automated, operatorId] of [
    [software, 'schema:SoftwareApplication', true, operator.id],
    [person, 'schema:Person', false, null],
    [organization, 'schema:Organization', false, null],
  ] as const) {
    const answer = await page({ account: account.handle });
    expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).not.toHaveProperty('subject');
    expect(answer.body.template).toEqual({ scope: 'type', key: type });
    const identity = (await get(`/v1/accounts?ids=${account.id}`)).body.accounts[0];
    expect(identity).toMatchObject({ id: account.id, automated, operatorId });
    expect(answer.body.reads.r0.body.accounts[0]).toMatchObject(identity);
  }
});

function population(hotPartition: number): Population {
  return {
    name: 'verified-agent-page-addresses',
    hotPartition,
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const subject = newId(route);
      const unrelated = newId(route);
      const account = newId(accountRoute);
      const receipt = randomUUID();
      const handle = `growth_${account.replaceAll('-', '')}`;
      return {
        'semantic.subject': [subject, unrelated].map((id) => ({
          route,
          subject_id: id,
          type: 'schema:Person',
          recorded_transaction_id: id,
        })),
        'access.account': [
          {
            route: accountRoute,
            account_id: account,
            kind: 'actor',
            state: 'active',
            handle,
            display_name: `Growth ${ordinal}`,
            transaction_id: account,
            agent_verified: true,
            agent_subject_id: subject,
            agent_verification_receipt_id: receipt,
          },
        ],
        'access.agent_page': [{ route, subject_id: subject, account_id: account, verification_receipt_id: receipt }],
        'access.handle_claim': [
          {
            route: createHash('sha256').update(handle).digest().readUInt16BE(0),
            normalized_handle: handle,
            account_id: account,
            state: 'active',
            transaction_id: account,
          },
        ],
      };
    },
  };
}

test('subject and handle page reads stay bounded as verified agents and unrelated subjects grow at three scales', async () => {
  const { account, subject } = await verified();
  const unrelated = await catalogueSubject('schema:Person', 'Growth subject without an account');
  const growing = population(partitionOf(routeOf(subject)!));
  for (const target of [{ subject }, { subject: unrelated }, { account: account.handle }]) {
    const report = await checkGrowth(db, {
      name: `Agent page address ${JSON.stringify(target)}`,
      scales: [128, 512, 2048],
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      grow: (database, scale, previous) => seed(database, growing, { from: previous, to: scale }),
      async operation() {
        const answer = await page(target);
        expect(answer.response.status).toBe('subject' in target && target.subject === subject ? 308 : 200);
        return answer.body;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([128, 512, 2048]);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  }
}, 180_000);
