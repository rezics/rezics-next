import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readPublicAccountCanonicalTargets } from '../../src/access/account-canonical-targets.ts';
import { completeAgentVerification, writeAgentVerificationPage } from '../../src/access/agent-verification.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import type { SummaryReaderDependencies } from '../../src/semantic/summaries.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
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

/** Existing native creation/verification and Account completion primitives. No
 * mapping, readiness, participant ACK or publication record is manufactured.
 */
async function linked(handle: string | null) {
  const accountId = newId(0x5c30);
  const subjectId = (await f.create('Canonical account target')).subject.id;
  const receiptId = newId(0);
  await f.pool.query(
    `INSERT INTO access.account(route, account_id, kind, state, handle, display_name, transaction_id,
       pending_agent_subject_id, pending_agent_receipt_id)
     VALUES($1,$2,'actor','active',$3,'Canonical account',$2,$4,$5)`,
    [routeOf(accountId), accountId, handle, subjectId, receiptId],
  );
  if (handle)
    await f.pool.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     VALUES($1,$2,$3,'active',$3)`,
      [claimRoute(handle), handle, accountId],
    );
  await ensureAccountAgent(f.pool, { account: accountId, kind: 'person', name: 'Canonical account' });
  await verifyAccountAgent(f.pool, { account: accountId, catalogue: subjectId, receipt: receiptId });
  const input = {
    id: newId(0),
    accountId,
    accountKind: 'actor' as const,
    requestedBy: f.accounts.editor,
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
