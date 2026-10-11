import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RealmReplyContentStore, RealmReplyUnavailable } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { startHomeStack, type HomeStack } from './feed-read-support.ts';
import { arrange, type Page, type Posted } from './zone-realm-discussion-support.ts';

type Interruption = 'draft' | 'identity' | 'preparation' | 'graph' | 'settlement';
const interruption = () => new RealmReplyUnavailable('Interrupted owner response');

/** Real owner effects commit first. Only their result transport is interrupted;
 * replay must resolve immutable receipts rather than make another contribution. */
function interruptAfter(home: HomeStack, point: Interruption) {
  let fired = false;
  const restore: (() => void)[] = [];
  if (point === 'draft') {
    const owner = home.stack.content, original = owner.saveDraft;
    owner.saveDraft = async function (command) {
      const saved = await original.call(this, command);
      if (!fired && command.model === 'member-reply-v1') { fired = true; throw interruption(); }
      return saved;
    };
    restore.push(() => { owner.saveDraft = original; });
  } else if (point === 'identity') {
    const owner = home.deps.realmReplies, original = owner.create;
    owner.create = async function (...args) {
      const saved = await original.apply(this, args);
      if (!fired) { fired = true; throw interruption(); }
      return saved;
    };
    restore.push(() => { owner.create = original; });
  } else if (point === 'preparation') {
    const owner = RealmReplyContentStore.prototype, original = owner.preparePlacement;
    owner.preparePlacement = async function (...args) {
      const saved = await original.apply(this, args);
      if (!fired) { fired = true; throw interruption(); }
      return saved;
    };
    restore.push(() => { owner.preparePlacement = original; });
  } else if (point === 'graph') {
    const owner = home.stack.fuseki, original = owner.commandWithReceipt, query = owner.query;
    let committedReceipt: string | undefined;
    owner.commandWithReceipt = async function (command) {
      const saved = await original.call(this, command);
      if (!fired && command.update.includes('a rv:RealmReplyPlacement') && saved.status === 'committed') {
        fired = true;
        committedReceipt = command.receipt;
        throw interruption();
      }
      return saved;
    };
    owner.query = async function (sparql, limit) {
      // The graph owner normally resolves a lost commit response immediately.
      // Keep just this receipt unavailable until the command returns, as an outage would.
      if (committedReceipt && sparql.includes(committedReceipt)) throw interruption();
      return query.call(this, sparql, limit);
    };
    restore.push(() => { owner.commandWithReceipt = original; owner.query = query; });
  } else {
    const owner = home.stack.content, original = owner.settlePublication;
    owner.settlePublication = async function (...args) {
      const saved = await original.apply(this, args);
      if (!fired && args[2].outcome === 'active') { fired = true; throw interruption(); }
      return saved;
    };
    restore.push(() => { owner.settlePublication = original; });
  }
  return { fired: () => fired, restore: () => { for (const undo of restore) undo(); } };
}

async function operation(home: HomeStack, realm: string, about: string) {
  const found = await home.stack.contentPool.query<{ id: string; reply: string; variant_id: string; phase: string;
    draft_operation_id: string | null; identity_operation_id: string | null; placement_admission_id: string | null }>(
    `SELECT id,reply,variant_id,phase,draft_operation_id,identity_operation_id,placement_admission_id
      FROM content.realm_about_post_operation WHERE realm=$1 AND about=$2`, [realm, about]);
  expect(found.rowCount).toBe(1);
  return found.rows[0]!;
}

async function acceptedPlacements(home: HomeStack, realm: string, reply: string) {
  const result = await home.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?placement WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ?placement a rv:RealmReplyPlacement ;
      rv:realm ${iri(realm)} ; rv:reply ${iri(reply)} ; rv:placementOutcome rv:Accepted . }
  } LIMIT 3`);
  return result.results?.bindings ?? [];
}

async function noOrphanPublicReply(home: HomeStack, realm: string, reply: string) {
  expect(await home.deps.realmReplies.readPublic(reply)).toBeNull();
  expect(await acceptedPlacements(home, realm, reply)).toHaveLength(0);
}

async function withdraw(home: HomeStack, a: Awaited<ReturnType<typeof arrange>>) {
  return home.json(await home.call('POST', `${a.sitePath}/realm-attachment-withdrawals`, {
    realm: a.realm.realm, actingSubject: a.author,
  }, home.author.token));
}

async function recovered(home: HomeStack, response: Response): Promise<Posted> {
  expect([200, 201]).toContain(response.status);
  return home.json<Posted>(response, response.status);
}

test('lost about-post responses after each durable owner phase resume one opener and preserve a pending child', async () => {
  const home = await startHomeStack('zone-realm-discussion-recovery', { projectionStart: 'current' });
  try {
    const a = await arrange(home);
    for (const point of ['draft', 'identity', 'preparation', 'graph', 'settlement'] as const) {
      const page = await a.page(`recover-${point}`), key = randomUUID(), childKey = randomUUID();
      const fault = interruptAfter(home, point);
      try {
        const response = await a.post(page, a.author, `Retained ${point} content`, home.author.token, key);
        expect(response.status, await response.text()).toBe(503);
        expect(fault.fired()).toBe(true);
      } finally { fault.restore(); }
      const selected = await operation(home, a.realm.realm, page.about);
      expect(selected.phase).toBe(point === 'draft' ? 'drafted' : 'identified');
      expect(selected.draft_operation_id).toBeTruthy();
      if (point !== 'draft') expect(selected.identity_operation_id).toBeTruthy();
      if (point === 'preparation' || point === 'graph' || point === 'settlement') {
        expect(selected.placement_admission_id).toBeTruthy();
        const durablePreparation = await home.stack.contentPool.query<{ status: string; pin_active: boolean }>(
          'SELECT status,pin_active FROM content.publication_preparation WHERE operation_id=$1',
          [selected.placement_admission_id]);
        expect(durablePreparation.rows).toEqual([{ status: point === 'settlement' ? 'active' : 'pending', pin_active: true }]);
        if (point === 'graph' || point === 'settlement') {
          expect(await acceptedPlacements(home, a.realm.realm, selected.reply)).toHaveLength(1);
        }
      }
      if (point === 'draft' || point === 'identity' || point === 'preparation') {
        await noOrphanPublicReply(home, a.realm.realm, selected.reply);
      }
      const pending = await home.json<{ operationId: string }>(await a.post(page, a.reader,
        `Waiting ${point} child`, home.reader.token, childKey), 202);
      expect(Object.keys(pending)).toEqual(['operationId']);
      const winner = await recovered(home, await a.post(page, a.author,
        `Retained ${point} content`, home.author.token, key));
      expect(winner).toMatchObject({ author: a.author, reply: selected.reply, about: page.about, realm: a.realm.realm });
      expect(Object.keys(winner).sort()).toEqual(['about', 'author', 'placement', 'profile', 'realm', 'reply', 'revisionId']);
      expect(await home.json(await a.post(page, a.author, `Retained ${point} content`, home.author.token, key), 200)).toEqual(winner);
      const child = await recovered(home, await a.post(page, a.reader, `Waiting ${point} child`, home.reader.token, childKey));
      expect(await home.json(await a.post(page, a.reader, `Waiting ${point} child`, home.reader.token, childKey), 200)).toEqual(child);
      const rows = await a.rows(page.about);
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => row.parent_reply === null)).toHaveLength(1);
      expect(rows.find(row => row.reply === winner.reply)).toMatchObject({ author: a.author,
        root_revision: page.targetRevision, origin_realm: a.realm.realm, body: { body: `Retained ${point} content` } });
      expect(rows.find(row => row.reply === child.reply)).toMatchObject({ author: a.reader,
        parent_reply: winner.reply, root_revision: page.targetRevision, origin_realm: a.realm.realm,
        body: { body: `Waiting ${point} child` } });
      expect(await a.effects(page.about)).toEqual({ threads: 1, operations: 2, replies: 2, revisions: 2 });
      const phases = await home.stack.contentPool.query(`SELECT phase,draft_operation_id,identity_operation_id,placement_operation_id
        FROM content.realm_about_post_operation WHERE realm=$1 AND about=$2`, [a.realm.realm, page.about]);
      expect(phases.rows).toHaveLength(2);
      expect(phases.rows.every(row => row.phase === 'posted' && row.draft_operation_id
        && row.identity_operation_id && row.placement_operation_id)).toBe(true);
      expect(await acceptedPlacements(home, a.realm.realm, winner.reply)).toHaveLength(1);
      expect(await acceptedPlacements(home, a.realm.realm, child.reply)).toHaveLength(1);
      const pins = await home.stack.contentPool.query(`SELECT p.status,p.pin_active
        FROM content.publication_preparation p JOIN content.realm_placement_preparation r ON r.operation_id=p.operation_id
        JOIN content.variant v ON v.id=r.variant_id WHERE v.resource_id=ANY($1::text[])`, [[winner.reply, child.reply]]);
      expect(pins.rows).toHaveLength(2);
      expect(pins.rows.every(row => row.status === 'active' && row.pin_active === true)).toBe(true);
    }
  } finally { await home.stop(); }
}, 300_000);

test('revoke or attachment withdrawal winning before dispatch leaves no public orphan or replacement opener', async () => {
  const home = await startHomeStack('zone-realm-discussion-dispatch-races', { projectionStart: 'current' });
  try {
    const a = await arrange(home);
    const revokedPage = await a.page('revoked-dispatch'), revokeKey = randomUUID();
    const replies = home.deps.realmReplies, originalPlace = replies.place;
    let revoked = false;
    replies.place = async function (...args) {
      if (!revoked) {
        revoked = true;
        // Bind this exact owner admission before revoking its authority epoch.
        await home.stack.access.register({ principal: args[0], actingSubject: args[1],
          action: 'reply.place', scope: `reply:place:${args[2].realm}`,
          idempotencyKey: args[3], requestDigest: args[4] });
        await home.stack.accessPool.query(`UPDATE access.scope_gate
          SET authority_epoch=authority_epoch+1 WHERE id=$1`, [`reply:place:${a.realm.realm}`]);
      }
      return originalPlace.apply(this, args);
    };
    try {
      const response = await a.post(revokedPage, a.author, 'Revoked before dispatch', home.author.token, revokeKey);
      expect(response.status, await response.text()).toBe(403);
      expect(revoked).toBe(true);
    } finally { replies.place = originalPlace; }
    const revokedOp = await operation(home, a.realm.realm, revokedPage.about);
    await noOrphanPublicReply(home, a.realm.realm, revokedOp.reply);
    const retry = await a.post(revokedPage, a.author, 'Revoked before dispatch', home.author.token, revokeKey);
    expect([403, 409], await retry.text()).toContain(retry.status);
    expect((await a.effects(revokedPage.about)).threads).toBe(1);
    const afterCancellation = await a.post(revokedPage, a.reader, 'After a terminal cancellation', home.reader.token);
    expect(afterCancellation.status, await afterCancellation.text()).toBe(409);

    const expiredPage = await a.page('expired-preparation'), expiredKey = randomUUID();
    const expiryFault = interruptAfter(home, 'preparation');
    try {
      const response = await a.post(expiredPage, a.author, 'Expired prepared contribution', home.author.token, expiredKey);
      expect(response.status, await response.text()).toBe(503);
      expect(expiryFault.fired()).toBe(true);
    } finally { expiryFault.restore(); }
    const expired = await operation(home, a.realm.realm, expiredPage.about);
    expect(expired.placement_admission_id).toBeTruthy();
    // Use the existing Access expiry rather than creating a composite replay clock.
    const expiredAdmission = await home.stack.accessPool.query(`UPDATE access.admission
      SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expired.placement_admission_id]);
    expect(expiredAdmission.rowCount).toBe(1);
    const expiredRetry = await a.post(expiredPage, a.author, 'Expired prepared contribution', home.author.token, expiredKey);
    expect([403, 409], await expiredRetry.text()).toContain(expiredRetry.status);
    await noOrphanPublicReply(home, a.realm.realm, expired.reply);
    expect((await a.effects(expiredPage.about)).threads).toBe(1);
    const expiredPreparation = await home.stack.contentPool.query(`SELECT status,pin_active
      FROM content.publication_preparation WHERE operation_id=$1`, [expired.placement_admission_id]);
    expect(expiredPreparation.rows).toEqual([{ status: 'rejected', pin_active: false }]);
    const expiredAgain = await a.post(expiredPage, a.author, 'Expired prepared contribution', home.author.token, expiredKey);
    expect([403, 409], await expiredAgain.text()).toContain(expiredAgain.status);
    expect((await operation(home, a.realm.realm, expiredPage.about)).reply).toBe(expired.reply);

    const page = await a.page('withdrawn-dispatch'), key = randomUUID();
    const graph = home.stack.fuseki, originalCommand = graph.commandWithReceipt;
    let withdrawn = false;
    graph.commandWithReceipt = async function (command) {
      if (!withdrawn && command.update.includes('a rv:RealmReplyPlacement')) {
        withdrawn = true;
        await withdraw(home, a);
      }
      return originalCommand.call(this, command);
    };
    try {
      const response = await a.post(page, a.author, 'Withdrawal before graph dispatch', home.author.token, key);
      expect(response.status, await response.text()).toBe(409);
      expect(withdrawn).toBe(true);
    } finally { graph.commandWithReceipt = originalCommand; }
    const selected = await operation(home, a.realm.realm, page.about);
    await noOrphanPublicReply(home, a.realm.realm, selected.reply);
    const preparations = await home.stack.contentPool.query(`SELECT p.status,p.pin_active
      FROM content.publication_preparation p JOIN content.realm_placement_preparation r ON r.operation_id=p.operation_id
      WHERE r.variant_id=$1`, [selected.variant_id]);
    expect(preparations.rows).toEqual([{ status: 'rejected', pin_active: false }]);
    const retryWithdrawn = await a.post(page, a.author, 'Withdrawal before graph dispatch', home.author.token, key);
    expect(retryWithdrawn.status, await retryWithdrawn.text()).toBe(409);
    expect((await a.effects(page.about)).threads).toBe(1);
  } finally { await home.stop(); }
}, 300_000);

test('a graph-committed first post survives withdrawal and revocation during lost-response recovery', async () => {
  const home = await startHomeStack('zone-realm-discussion-committed-recovery', { projectionStart: 'current' });
  try {
    const a = await arrange(home), page: Page = await a.page('committed-winner'), key = randomUUID();
    const fault = interruptAfter(home, 'graph');
    try {
      const response = await a.post(page, a.author, 'Committed winner', home.author.token, key);
      expect(response.status, await response.text()).toBe(503);
      expect(fault.fired()).toBe(true);
    } finally { fault.restore(); }
    const selected = await operation(home, a.realm.realm, page.about);
    expect(await acceptedPlacements(home, a.realm.realm, selected.reply)).toHaveLength(1);
    await withdraw(home, a);
    await home.stack.accessPool.query(`UPDATE access.scope_gate
      SET authority_epoch=authority_epoch+1 WHERE id=$1`, [`reply:place:${a.realm.realm}`]);
    const winner = await recovered(home, await a.post(page, a.author, 'Committed winner', home.author.token, key));
    expect(winner.reply).toBe(selected.reply);
    expect(await home.json(await a.post(page, a.author, 'Committed winner', home.author.token, key), 200)).toEqual(winner);
    expect(await a.effects(page.about)).toEqual({ threads: 1, operations: 1, replies: 1, revisions: 1 });
    expect(await acceptedPlacements(home, a.realm.realm, winner.reply)).toHaveLength(1);
    expect((await operation(home, a.realm.realm, page.about)).phase).toBe('posted');
    const preparation = await home.stack.contentPool.query(`SELECT p.status,p.pin_active
      FROM content.publication_preparation p JOIN content.realm_placement_preparation r ON r.operation_id=p.operation_id
      WHERE r.variant_id=$1`, [selected.variant_id]);
    expect(preparation.rows).toEqual([{ status: 'active', pin_active: true }]);
  } finally { await home.stop(); }
}, 300_000);
