import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readPublicAccountCanonicalTargets } from '../../src/access/account-canonical-targets.ts';
import {
  completeAgentVerification,
  createAgentVerificationCommands,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
} from '../../src/access/agent-verification.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import type { SummaryReaderDependencies } from '../../src/semantic/summaries.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { createIdentityRegistrar } from '../support/identity-registration.ts';
import { startIdentityWorkProcess } from '../support/identity-work-process.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';

let f: EpochFixture;
let registrar: ReturnType<typeof createIdentityRegistrar>;
let workClient: WorkClient;
let identityWork: Awaited<ReturnType<typeof startIdentityWorkProcess>> | undefined;
beforeAll(async () => {
  f = await epochFixture();
  registrar = createIdentityRegistrar(f.pool, new Uint8Array(32).fill(37));
  // Account completion publishes through the real identity coordinator. The production executor runs in a child
  // process; this process only enqueues through its DBOS client.
  const databaseUrl = process.env.DATABASE_URL!;
  workClient = await createWorkClient(databaseUrl, f.pool);
  identityWork = await startIdentityWorkProcess({
    databaseUrl,
    routeKey: Buffer.from(new Uint8Array(32).fill(37)).toString('base64url'),
    openSearchUrl: process.env.OPENSEARCH_URL,
    // A check run and its load reruns share one OpenSearch; each composition owns fresh index names.
    searchPrefix: `canonical-targets-${randomUUID().slice(0, 8)}-`,
  });
}, 60_000);
afterAll(async () => {
  await identityWork?.stop();
  await workClient?.close();
  await f?.close();
});

function deps(): SummaryReaderDependencies {
  return {
    pool: f.pool,
    routeKey: new Uint8Array(32).fill(37),
    access: f.access,
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  };
}

/** Native request, approval and pending commands create the only verification receipt. Account completion
 * follows. No pending column, mapping, readiness, participant ACK or publication record is manufactured.
 */
async function linked(handle: string | null) {
  const accountId = newId(0x5c30);
  const reviewerId = newId(0x5c31);
  const subjectId = (await f.create('Canonical account target')).subject.id;
  const actions = ['account:update', 'account:verify_agent'];
  // A named account enters through production registration, so its claim emits discovery events. A handleless
  // identity has no claim and keeps the bare active row that createRealAccess writes.
  if (handle) await registrar.registerActor(handle, accountId);
  const real = await createRealAccess(f.admin, { owner: accountId, reviewer: reviewerId }, actions, {
    registered: handle ? ['owner'] : [],
  });
  const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  await real.grant({ route: routeOf(accountId)!, id: accountId }, 'owner', 'account:update');
  await real.grant(PLATFORM_RESOURCE, 'reviewer', 'account:verify_agent');
  const context = async (persona: 'owner' | 'reviewer') => {
    // Approval publishes the identity through the coordinator, which needs the same budget as the page fixture.
    const deadline = Date.now() + 30_000;
    return {
      pool: f.pool,
      deadline,
      actor: await access.authenticate(real.bearer(persona), { pool: f.pool, deadline }),
    };
  };
  await f.pool.query(`UPDATE access.account SET display_name='Canonical account' WHERE route=$1 AND account_id=$2`, [
    routeOf(accountId),
    accountId,
  ]);
  await ensureAccountAgent(f.pool, { account: accountId, kind: 'person', name: 'Canonical account' });
  const commands = createAgentVerificationCommands({ pool: f.pool, access, clock: () => new Date() });
  const request = await commands.request(await context('owner'), {
    accountId,
    subject: subjectId,
    statement: 'This is my canonical account',
    links: [],
    key: randomUUID(),
  });
  const decision = await commands.approve(await context('reviewer'), {
    requestId: request.value.id,
    key: randomUUID(),
  });
  const receiptId = decision.value.decisionReceiptId!;
  const workflow = { ...(await readAgentVerificationWorkflowRequest(f.pool, request.value.id))!, receiptId };
  await recordPendingAgentVerification(f.pool, workflow, () => new Date());
  await verifyAccountAgent(f.pool, { account: accountId, catalogue: subjectId, receipt: receiptId });
  const input = {
    id: newId(0),
    accountId,
    accountKind: 'actor' as const,
    requestedBy: accountId,
    catalogueSubjectId: subjectId,
    state: 'approving' as const,
    decisionReceiptId: receiptId,
    receiptId,
  };
  await writeAgentVerificationPage(f.pool, input);
  await completeAgentVerification(f.pool, input, () => new Date());
  return { accountId, subjectId, receiptId };
}

function claimRoute(handle: string) {
  return createHash('sha256').update(handle).digest().readUInt16BE(0);
}
function uniqueHandle() {
  return `canonical_${newId(0).replaceAll('-', '')}`;
}

test('actual bounded anonymous canonical Account targets require reciprocal native verification and current exact claims while valid handleless identities never acquire a phantom public URL', async () => {
  const handle = uniqueHandle();
  const named = await linked(handle);
  const handleless = await linked(null);
  const unrelated = (await f.create('Independent catalogue person')).subject.id;
  const targets = await readPublicAccountCanonicalTargets(deps(), [
    named.subjectId,
    handleless.subjectId,
    unrelated,
    named.subjectId,
  ]);
  expect(targets.size).toBe(3);
  expect(targets.get(named.subjectId)).toEqual({
    accountId: named.accountId,
    accountKind: 'actor',
    handle,
    canonicalPath: `/@${encodeURIComponent(handle)}`,
    views: ['overview', 'posts', 'reviews', 'collections'],
  });
  expect(targets.get(handleless.subjectId)).toEqual({
    accountId: handleless.accountId,
    accountKind: 'actor',
    handle: null,
    canonicalPath: null,
    views: [],
  });
  expect(targets.get(unrelated)).toBeNull();

  // A claim can stop authorizing navigation while the Account identity stays valid.
  for (const state of ['reserved', 'former', 'pending'] as const) {
    await f.pool.query(
      `UPDATE access.handle_claim SET state=$3,
         reserved_until=CASE WHEN $3='reserved' THEN now()+interval '1 day' END,
         expires_at=CASE WHEN $3='pending' THEN now()+interval '1 day' END,
         former_until=CASE WHEN $4 THEN now()+interval '1 day' END
       WHERE route=$1 AND normalized_handle=$2`,
      [claimRoute(handle), handle, state === 'former' ? 'reserved' : state, state === 'former'],
    );
    expect((await readPublicAccountCanonicalTargets(deps(), [named.subjectId])).get(named.subjectId)).toEqual({
      accountId: named.accountId,
      accountKind: 'actor',
      handle: null,
      canonicalPath: null,
      views: [],
    });
  }
  await f.pool.query(
    `UPDATE access.handle_claim SET state='active', account_id=$3,
    expires_at=NULL, reserved_until=NULL, former_until=NULL WHERE route=$1 AND normalized_handle=$2`,
    [claimRoute(handle), handle, f.accounts.outsider],
  );
  expect(
    (await readPublicAccountCanonicalTargets(deps(), [named.subjectId])).get(named.subjectId)?.canonicalPath,
  ).toBeNull();
  await f.pool.query('DELETE FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [
    claimRoute(handle),
    handle,
  ]);
  expect((await readPublicAccountCanonicalTargets(deps(), [named.subjectId])).get(named.subjectId)?.handle).toBeNull();
});

test('current fences and wrong reciprocal links withhold targets; missing required native authority is unavailable', async () => {
  const target = await linked(null);
  await f.pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(target.accountId),
    target.accountId,
  ]);
  expect((await readPublicAccountCanonicalTargets(deps(), [target.subjectId])).get(target.subjectId)).toBeNull();
  await f.pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
    routeOf(target.accountId),
    target.accountId,
  ]);
  await f.pool.query('UPDATE access.agent_page SET verification_receipt_id=$3 WHERE route=$1 AND subject_id=$2', [
    routeOf(target.subjectId),
    target.subjectId,
    newId(0),
  ]);
  expect((await readPublicAccountCanonicalTargets(deps(), [target.subjectId])).get(target.subjectId)).toBeNull();
  await f.pool.query('UPDATE access.agent_page SET verification_receipt_id=$3 WHERE route=$1 AND subject_id=$2', [
    routeOf(target.subjectId),
    target.subjectId,
    target.receiptId,
  ]);
  const agentId = accountAgentId(target.accountId);
  await f.pool.query('DELETE FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2', [
    routeOf(agentId),
    agentId,
  ]);
  await expect(readPublicAccountCanonicalTargets(deps(), [target.subjectId])).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
});

test('released foreign hydration uses anonymous Access and rechecks the native Account after a concurrent fence', async () => {
  const target = await linked(uniqueHandle());
  const reader = deps();
  reader.actor = await f.actor(); // A signed-in caller must not broaden this public port.
  let checked = false;
  reader.access = {
    ...f.access,
    async authorize(client, actor, action, resource, evidence, time) {
      expect(actor.kind).toBe('anonymous');
      const allowed = await f.access.authorize(client, actor, action, resource, evidence, time);
      if (!checked) {
        checked = true;
        await f.pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
          routeOf(target.accountId),
          target.accountId,
        ]);
      }
      return allowed;
    },
  };
  expect((await readPublicAccountCanonicalTargets(reader, [target.subjectId])).get(target.subjectId)).toBeNull();
  expect(checked).toBe(true);
});

test('Current native Account activity-view admission is batched with canonical targets without Subject template inference', async () => {
  const named = await linked(uniqueHandle());
  const handleless = await linked(null);
  const flags = { posts: true, reviews: true, collections: true };
  for (const view of ['posts', 'reviews', 'collections'] as const) {
    flags[view] = false;
    await f.pool.query(
      'UPDATE access.account SET public_views=public_views || $3::jsonb WHERE route=$1 AND account_id=$2',
      [routeOf(named.accountId), named.accountId, JSON.stringify({ [view]: false })],
    );
    const targets = await readPublicAccountCanonicalTargets(deps(), [named.subjectId, handleless.subjectId]);
    expect(targets.get(named.subjectId)?.views).toEqual([
      'overview',
      ...(['posts', 'reviews', 'collections'] as const).filter((name) => flags[name]),
    ]);
    // The same Subject type and native defaults never give a handleless identity navigation.
    expect(targets.get(handleless.subjectId)?.views).toEqual([]);
  }
  await f.pool.query(
    'UPDATE access.account SET public_views=public_views || $3::jsonb WHERE route=$1 AND account_id=$2',
    [routeOf(named.accountId), named.accountId, JSON.stringify({ reviews: true })],
  );
  expect((await readPublicAccountCanonicalTargets(deps(), [named.subjectId])).get(named.subjectId)?.views).toEqual([
    'overview',
    'reviews',
  ]);
});

test('native view changes during released foreign hydration withhold the candidate until a fresh observation', async () => {
  for (const enabled of [false, true]) {
    const target = await linked(uniqueHandle());
    await f.pool.query(
      'UPDATE access.account SET public_views=public_views || $3::jsonb WHERE route=$1 AND account_id=$2',
      [routeOf(target.accountId), target.accountId, JSON.stringify({ posts: !enabled })],
    );
    const reader = deps();
    let changed = false;
    reader.access = {
      ...f.access,
      async authorize(client, actor, action, resource, evidence, time) {
        expect(actor.kind).toBe('anonymous');
        const allowed = await f.access.authorize(client, actor, action, resource, evidence, time);
        if (!changed) {
          changed = true;
          await f.pool.query(
            'UPDATE access.account SET public_views=public_views || $3::jsonb WHERE route=$1 AND account_id=$2',
            [routeOf(target.accountId), target.accountId, JSON.stringify({ posts: enabled })],
          );
        }
        return allowed;
      },
    };
    expect((await readPublicAccountCanonicalTargets(reader, [target.subjectId])).get(target.subjectId)).toBeNull();
    expect(changed).toBe(true);
    expect((await readPublicAccountCanonicalTargets(deps(), [target.subjectId])).get(target.subjectId)?.views).toEqual(
      enabled ? ['overview', 'posts', 'reviews', 'collections'] : ['overview', 'reviews', 'collections'],
    );
  }
});

test('the entire input bound, routed keys and trusted route key are validated before I/O', async () => {
  let calls = 0;
  const reader = deps();
  reader.pool = {
    connect() {
      calls++;
      throw new Error('Unexpected I/O');
    },
  } as unknown as typeof reader.pool;
  const id = newId(0);
  await expect(readPublicAccountCanonicalTargets(reader, Array(101).fill(id))).rejects.toBeInstanceOf(RangeError);
  await expect(readPublicAccountCanonicalTargets(reader, [id, 'bad'])).rejects.toBeInstanceOf(TypeError);
  await expect(
    readPublicAccountCanonicalTargets({ ...reader, routeKey: new Uint8Array(0) }, []),
  ).rejects.toBeInstanceOf(TypeError);
  expect(await readPublicAccountCanonicalTargets(reader, [])).toEqual(new Map());
  expect(calls).toBe(0);
});
