import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RealmReplyConflict, RealmReplyContentStore, RealmReplyUnavailable } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { ContentConflict } from '../../../services/content/src/core.ts';
import { WorkReadLimit } from '../../../services/main/src/modules/work/read-session.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable } from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import type { TitleControlState } from '../../../services/main/src/modules/work/title-control.ts';
import { RealmAboutThreadStore } from '../../../services/main/src/modules/realm-reply/about-store.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { startHomeStack, type HomeStack } from './feed-read-support.ts';
import { arrange, local, type Page, type Posted } from './zone-realm-discussion-support.ts';

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
    draft_operation_id: string | null; identity_operation_id: string | null; placement_admission_id: string | null; terminal_refusal: boolean }>(
    `SELECT id,reply,variant_id,phase,draft_operation_id,identity_operation_id,placement_admission_id,terminal_refusal
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

async function refusal(response: Response, status: 403 | 409) {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return { status: response.status, body };
}

test('a graph-committed first post survives withdrawal and revocation during lost-response recovery', async () => {
  const home = await startHomeStack('zone-realm-discussion-committed-recovery');
  try {
    const a = await arrange(home), page: Page = await a.page('committed-winner'), key = randomUUID();
    const fault = interruptAfter(home, 'graph');
    try {
      const response = await a.post(page, a.author, 'Committed winner', home.author.token, key);
      const body = await response.clone().text();
      expect(response.status, body).toBe(503);
      expect(fault.fired()).toBe(true);
    } finally { fault.restore(); }
    const selected = await operation(home, a.realm.realm, page.about);
    expect(await acceptedPlacements(home, a.realm.realm, selected.reply)).toHaveLength(1);
    await withdraw(home, a);
    await a.policy(a.realm.realm, 'mandatory');
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

test('a fresh refusal overlapping a same-key dispatched winner preserves its immutable outcome', async () => {
  const home = await startHomeStack('zone-realm-discussion-same-key-refusal');
  try {
    const a = await arrange(home);
    for (const outcome of ['dispatched', 'posted'] as const) {
      const page = await a.page(`same-key-${outcome}`), key = randomUUID(), text = 'One immutable same-key contribution';
      const owner = RealmAboutThreadStore.prototype;
      const read = owner.readIntent, posted = owner.recordPosted, refuse = owner.refuseIntent;
      let miss!: () => void, releaseRead!: () => void, reachedPosted!: () => void, releasePosted!: () => void;
      const missed = new Promise<void>(resolve => { miss = resolve; });
      const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
      const posting = new Promise<void>(resolve => { reachedPosted = resolve; });
      const heldPosted = new Promise<void>(resolve => { releasePosted = resolve; });
      let first = true;
      const decisions: Awaited<ReturnType<typeof refuse>>[] = [];
      owner.readIntent = async function (...args) {
        const result = await read.apply(this, args);
        if (args[1] === key && first) {
          first = false;
          expect(result).toBeNull();
          miss();
          await heldRead;
        }
        return result;
      };
      owner.recordPosted = async function (...args) {
        if (outcome === 'dispatched') { reachedPosted(); await heldPosted; }
        return posted.apply(this, args);
      };
      owner.refuseIntent = async function (...args) {
        const result = await refuse.apply(this, args);
        if (args[1] === key) decisions.push(result);
        return result;
      };
      let laggingRequest: Promise<Response> | undefined, winnerRequest: Promise<Response> | undefined;
      const barrier = async (at: Promise<void>, request: Promise<Response>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([at, request.then(async response => {
            throw new Error(`Request returned before owner barrier: ${response.status} ${await response.clone().text()}`);
          }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owner barrier timed out')), 30_000); })]);
        } finally { clearTimeout(timer); }
      };
      try {
        laggingRequest = a.post(page, a.author, text, home.author.token, key);
        await barrier(missed, laggingRequest);
        winnerRequest = a.post(page, a.author, text, home.author.token, key);
        let winner: Posted | undefined;
        if (outcome === 'dispatched') await barrier(posting, winnerRequest);
        else winner = await home.json<Posted>(await winnerRequest, 201);
        const before = await operation(home, a.realm.realm, page.about);
        expect(before).toMatchObject({ phase: outcome === 'posted' ? 'posted' : 'identified', terminal_refusal: false });
        expect(before.placement_admission_id).toBeTruthy();
        expect(await acceptedPlacements(home, a.realm.realm, before.reply)).toHaveLength(1);
        // Change the actual public policy after the winner's graph commit. No
        // injected error or authority bypass supplies the lagging refusal.
        await a.policy(a.realm.realm, 'mandatory');
        releaseRead();
        const lagging = await laggingRequest;
        const answer = await lagging.json();
        const retained = await operation(home, a.realm.realm, page.about);
        expect(decisions).toMatchObject([{ kind: outcome === 'posted' ? 'posted' : 'recoverable' }]);
        expect(retained).toEqual(before);
        expect(lagging.status).toBe(outcome === 'posted' ? 200 : 503);
        if (outcome === 'dispatched') {
          expect(answer).toMatchObject({ code: 'realm_reply_unavailable', title: 'Discussion dispatch recovery is pending' });
          releasePosted();
          winner = await home.json<Posted>(await winnerRequest, 201);
        } else expect(answer).toEqual(winner);
        // Settled success replays while the newer review policy still refuses
        // fresh posts. Its immutable answer is not relabeled by that policy.
        expect(await home.json(await a.post(page, a.author, text, home.author.token, key), 200)).toEqual(winner);
        expect(await operation(home, a.realm.realm, page.about)).toMatchObject({ phase: 'posted', terminal_refusal: false });
        const terminal = (await home.stack.contentPool.query(`SELECT terminal_outcome FROM content.realm_about_post_operation
          WHERE id=$1`, [before.id])).rows[0];
        expect(terminal).toEqual({ terminal_outcome: null });
        expect(await a.effects(page.about)).toEqual({ threads: 1, operations: 1, replies: 1, revisions: 1 });
        expect(await acceptedPlacements(home, a.realm.realm, before.reply)).toHaveLength(1);
      } finally {
        releaseRead(); releasePosted();
        await Promise.allSettled([laggingRequest, winnerRequest].filter(request => request !== undefined));
        owner.readIntent = read; owner.recordPosted = posted; owner.refuseIntent = refuse;
        await a.policy(a.realm.realm, 'open');
      }
    }
  } finally { await home.stop(); }
}, 300_000);


test('lost about-post responses after each durable owner phase resume one opener and preserve a pending child', async () => {
  const home = await startHomeStack('zone-realm-discussion-recovery');
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

test('cancelled and expired first posts release their reservation while retaining terminal intent outcomes', async () => {
  const home = await startHomeStack('zone-realm-discussion-dispatch-races');
  try {
    const a = await arrange(home);
    const revokedPage = await a.page('revoked-dispatch'), revokeKey = randomUUID();
    const replies = home.deps.realmReplies, originalPlace = replies.place;
    let revoked = false;
    let revokedRefusal: Awaited<ReturnType<typeof refusal>> | undefined;
    replies.place = async function (...args) {
      if (!revoked) {
        revoked = true;
        await a.policy(a.realm.realm, 'mandatory');
      }
      return originalPlace.apply(this, args);
    };
    try {
      const response = await a.post(revokedPage, a.author, 'Revoked before dispatch', home.author.token, revokeKey);
      revokedRefusal = await refusal(response, 403);
      expect(revoked).toBe(true);
    } finally { replies.place = originalPlace; }
    const revokedOp = await operation(home, a.realm.realm, revokedPage.about);
    await noOrphanPublicReply(home, a.realm.realm, revokedOp.reply);
    const retry = await a.post(revokedPage, a.author, 'Revoked before dispatch', home.author.token, revokeKey);
    expect(await refusal(retry, 403)).toEqual(revokedRefusal);
    expect((await a.effects(revokedPage.about)).threads).toBe(0);
    await a.policy(a.realm.realm, 'open');
    const reopenedPage = { ...revokedPage, routeRevision: (await a.route(revokedPage.path)).revision };
    const reopened = await home.json<Posted>(await a.post(reopenedPage, a.reader,
      'After a terminal cancellation', home.reader.token), 201);
    expect(reopened.reply).not.toBe(revokedOp.reply);
    expect((await a.rows(revokedPage.about)).find(row => row.reply === reopened.reply)).toMatchObject({ parent_reply: null });
    const oldRetry = await a.post(revokedPage, a.author, 'Revoked before dispatch', home.author.token, revokeKey);
    expect(await refusal(oldRetry, 403)).toEqual(revokedRefusal);
    expect((await a.effects(revokedPage.about)).threads).toBe(1);

    const expiredPage = await a.page('expired-preparation'), expiredKey = randomUUID();
    const expiryFault = interruptAfter(home, 'preparation');
    try {
      const response = await a.post(expiredPage, a.author, 'Expired prepared contribution', home.author.token, expiredKey);
      expect(response.status, await response.text()).toBe(503);
      expect(expiryFault.fired()).toBe(true);
    } finally { expiryFault.restore(); }
    const expired = await operation(home, a.realm.realm, expiredPage.about);
    expect(expired.placement_admission_id).toBeTruthy();
    // Wait for Access's native lease; no fixture changes its durable clock.
    const expiry = (await home.stack.accessPool.query<{ remaining: number }>(`SELECT
      GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp())*1000)::double precision AS remaining
      FROM access.admission WHERE id=$1`, [expired.placement_admission_id])).rows[0]!;
    expect(expiry.remaining).toBeLessThanOrEqual(30_000);
    await Bun.sleep(Math.ceil(expiry.remaining) + 100);
    const nativePlace = home.deps.realmReplies.place;
    let nativeFailure: Error | undefined;
    home.deps.realmReplies.place = async function (...args) {
      try { return await nativePlace.apply(this, args); }
      catch (error) { if (error instanceof Error) nativeFailure = error; throw error; }
    };
    let expiredRetry: Response | undefined;
    try {
      // Expiry is not a terminal proof while the native cancellation/cleanup
      // outcome is unknown. Retry that same intent within a bounded recovery.
      for (let attempt = 0; attempt < 3; attempt++) {
        expiredRetry = await a.post(expiredPage, a.author, 'Expired prepared contribution', home.author.token, expiredKey);
        if (expiredRetry.status !== 503) break;
        const retained = (await home.stack.contentPool.query(`SELECT terminal_outcome,terminal_refusal
          FROM content.realm_about_post_operation WHERE id=$1`, [expired.id])).rows[0];
        expect(retained).toEqual({ terminal_outcome: null, terminal_refusal: false });
        await Bun.sleep(100);
      }
    } finally { home.deps.realmReplies.place = nativePlace; }
    if (!expiredRetry) throw new Error('Expected native expiry recovery');
    expect(expiredRetry.status, nativeFailure ? `${nativeFailure.constructor.name}: ${nativeFailure.message}` : undefined).toBe(409);
    const expiredRefusal = await refusal(expiredRetry, 409);
    await noOrphanPublicReply(home, a.realm.realm, expired.reply);
    expect((await a.effects(expiredPage.about)).threads).toBe(0);
    const expiredPreparation = await home.stack.contentPool.query(`SELECT status,pin_active
      FROM content.publication_preparation WHERE operation_id=$1`, [expired.placement_admission_id]);
    expect(expiredPreparation.rows).toEqual([{ status: 'rejected', pin_active: false }]);
    const expiredAgain = await a.post(expiredPage, a.author, 'Expired prepared contribution', home.author.token, expiredKey);
    expect(await refusal(expiredAgain, 409)).toEqual(expiredRefusal);
    expect((await operation(home, a.realm.realm, expiredPage.about)).reply).toBe(expired.reply);
    const afterExpiry = await home.json<Posted>(await a.post(expiredPage, a.reader,
      'A fresh intent after native expiry', home.reader.token), 201);
    expect(afterExpiry.reply).not.toBe(expired.reply);
    expect((await a.rows(expiredPage.about)).find(row => row.reply === afterExpiry.reply)).toMatchObject({ parent_reply: null });
    expect(await refusal(await a.post(expiredPage, a.author,
      'Expired prepared contribution', home.author.token, expiredKey), 409)).toEqual(expiredRefusal);
    expect((await a.effects(expiredPage.about)).threads).toBe(1);

    const cleanupPage = await a.page('cancelled-settlement-conflict'), cleanupKey = randomUUID();
    const preparationFault = interruptAfter(home, 'preparation');
    try {
      const response = await a.post(cleanupPage, a.author, 'Cancelled with unfinished cleanup', home.author.token, cleanupKey);
      expect(response.status, await response.text()).toBe(503);
      expect(preparationFault.fired()).toBe(true);
    } finally { preparationFault.restore(); }
    const cleanup = await operation(home, a.realm.realm, cleanupPage.about);
    await a.policy(a.realm.realm, 'mandatory');
    const content = home.stack.content, originalSettle = content.settlePublication;
    let cleanupFault = false;
    content.settlePublication = async function (...args) {
      if (!cleanupFault && args[2].outcome === 'rejected') {
        cleanupFault = true;
        throw new ContentConflict('Rejected settlement conflict');
      }
      return originalSettle.apply(this, args);
    };
    try {
      const response = await a.post(cleanupPage, a.author, 'Cancelled with unfinished cleanup', home.author.token, cleanupKey);
      expect(response.status, await response.text()).toBe(503);
      expect(cleanupFault).toBe(true);
    } finally { content.settlePublication = originalSettle; }
    const retainedCleanup = (await home.stack.contentPool.query(`SELECT terminal_outcome,terminal_refusal
      FROM content.realm_about_post_operation WHERE id=$1`, [cleanup.id])).rows[0];
    expect(retainedCleanup).toEqual({ terminal_outcome: null, terminal_refusal: false });
    expect((await home.stack.contentPool.query(`SELECT status,pin_active FROM content.publication_preparation
      WHERE operation_id=$1`, [cleanup.placement_admission_id])).rows).toEqual([{ status: 'pending', pin_active: true }]);
    expect((await a.effects(cleanupPage.about)).threads).toBe(1);
    await a.policy(a.realm.realm, 'open');
    const replacementPage = { ...cleanupPage, routeRevision: (await a.route(cleanupPage.path)).revision };
    const replacement = await home.json<Posted>(await a.post(replacementPage, a.reader,
      'Fresh opener while old cancellation cleanup is pending', home.reader.token), 201);
    expect(replacement.reply).not.toBe(cleanup.reply);
    const cleanupRetry = await a.post(cleanupPage, a.author, 'Cancelled with unfinished cleanup', home.author.token, cleanupKey);
    const cleanupRefusal = await refusal(cleanupRetry, 409);
    expect((await home.stack.contentPool.query(`SELECT status,pin_active FROM content.publication_preparation
      WHERE operation_id=$1`, [cleanup.placement_admission_id])).rows).toEqual([{ status: 'rejected', pin_active: false }]);
    expect((await home.stack.accessPool.query('SELECT state,graph_outcome FROM access.admission WHERE id=$1',
      [cleanup.placement_admission_id])).rows).toEqual([{ state: 'sealed', graph_outcome: 'cancelled' }]);
    expect((await a.effects(cleanupPage.about)).threads).toBe(1);
    expect(await refusal(await a.post(cleanupPage, a.author, 'Cancelled with unfinished cleanup',
      home.author.token, cleanupKey), 409)).toEqual(cleanupRefusal);
    await noOrphanPublicReply(home, a.realm.realm, cleanup.reply);

    const page = await a.page('withdrawn-dispatch'), key = randomUUID();
    const graph = home.stack.fuseki, originalCommand = graph.commandWithReceipt;
    let withdrawn = false;
    let withdrawnRefusal: Awaited<ReturnType<typeof refusal>> | undefined;
    graph.commandWithReceipt = async function (command) {
      if (!withdrawn && command.update.includes('a rv:RealmReplyPlacement')) {
        withdrawn = true;
        await withdraw(home, a);
      }
      return originalCommand.call(this, command);
    };
    try {
      const response = await a.post(page, a.author, 'Withdrawal before graph dispatch', home.author.token, key);
      withdrawnRefusal = await refusal(response, 409);
      expect(withdrawn).toBe(true);
    } finally { graph.commandWithReceipt = originalCommand; }
    const selected = await operation(home, a.realm.realm, page.about);
    await noOrphanPublicReply(home, a.realm.realm, selected.reply);
    const preparations = await home.stack.contentPool.query(`SELECT p.status,p.pin_active
      FROM content.publication_preparation p JOIN content.realm_placement_preparation r ON r.operation_id=p.operation_id
      WHERE r.variant_id=$1`, [selected.variant_id]);
    expect(preparations.rows).toEqual([{ status: 'rejected', pin_active: false }]);
    const retryWithdrawn = await a.post(page, a.author, 'Withdrawal before graph dispatch', home.author.token, key);
    expect(await refusal(retryWithdrawn, 409)).toEqual(withdrawnRefusal);
    expect((await a.effects(page.about)).threads).toBe(0);
  } finally { await home.stop(); }
}, 300_000);




async function editPage(home: HomeStack, a: Awaited<ReturnType<typeof arrange>>, page: Page): Promise<Page> {
  await grantFixtureAuthority(home.stack.accessPool, { scope: `work:edit:${page.about}`, requireDispatch: true,
    representations: [{ principalId: home.author.principalId, actor: a.author, action: 'work.edit', lifetime: '8 hours' }],
    grant: { actor: a.author, action: 'work.edit', lifetime: '8 hours' } });
  const basis = await home.json<TitleControlState>(await home.call('GET',
    `/v1/works/${local(page.about)}/title-control?${new URLSearchParams({ actingSubject: a.author })}`,
    undefined, home.author.token));
  await home.json(await home.call('POST', '/v1/content-edits', {
    profile: 'metadata-only-v1', work: page.about, expectedHead: basis.contentHead,
    titleControl: basis.basis, title: 'A revised discussion page', actingSubject: a.author,
  }, home.author.token));
  return { ...page, routeRevision: (await a.route(page.path)).revision,
    targetRevision: await a.targetRevision(page.about) };
}

test('stale pre-placement bases release retained draft and identity intents so a corrected post opens the discussion', async () => {
  const home = await startHomeStack('zone-realm-discussion-stale-recovery');
  try {
    const a = await arrange(home);
    for (const point of ['draft', 'identity'] as const) {
      const page = await a.page(`stale-${point}`), key = randomUUID(), text = `Retained ${point} words`;
      const fault = interruptAfter(home, point);
      try {
        const response = await a.post(page, a.author, text, home.author.token, key);
        expect(response.status, await response.text()).toBe(503);
        expect(fault.fired()).toBe(true);
      } finally { fault.restore(); }
      const before = await operation(home, a.realm.realm, page.about);
      const current = await editPage(home, a, page);
      const retry = await a.post(page, a.author, text, home.author.token, key);
      const staleRefusal = await refusal(retry, 409);
      const failed = await operation(home, a.realm.realm, page.about);
      expect(failed).toEqual({ ...before, terminal_refusal: true });
      expect((await a.effects(page.about)).threads).toBe(0);
      await noOrphanPublicReply(home, a.realm.realm, failed.reply);
      const winner = await home.json<Posted>(await a.post(current, a.reader,
        'Corrected post on the current page', home.reader.token), 201);
      expect(winner.reply).not.toBe(failed.reply);
      expect((await a.rows(page.about)).find(row => row.reply === winner.reply)).toMatchObject({
        parent_reply: null, root_revision: current.targetRevision, author: a.reader });
      const sameKey = await a.post(page, a.author, text, home.author.token, key);
      expect(await refusal(sameKey, 409)).toEqual(staleRefusal);
      expect(await acceptedPlacements(home, a.realm.realm, failed.reply)).toHaveLength(0);
    }
    const page = await a.page('changed-after-draft'), key = randomUUID();
    const owner = RealmAboutThreadStore.prototype, original = owner.recordDraftRevision;
    let edited: Page | undefined;
    let draftRefusal: Awaited<ReturnType<typeof refusal>> | undefined;
    owner.recordDraftRevision = async function (...args) {
      const saved = await original.apply(this, args);
      if (!edited) edited = await editPage(home, a, page);
      return saved;
    };
    try {
      const refused = await a.post(page, a.author, 'Words drafted before the page edit', home.author.token, key);
      draftRefusal = await refusal(refused, 409);
    } finally { owner.recordDraftRevision = original; }
    const failed = await operation(home, a.realm.realm, page.about);
    expect(failed).toMatchObject({ phase: 'drafted', terminal_refusal: true, placement_admission_id: null });
    expect((await a.effects(page.about)).threads).toBe(0);
    if (!edited) throw new Error('Expected the native page edit');
    const winner = await home.json<Posted>(await a.post(edited, a.reader, 'Fresh corrected words', home.reader.token), 201);
    expect(winner.reply).not.toBe(failed.reply);
    expect(await refusal(await a.post(page, a.author,
      'Words drafted before the page edit', home.author.token, key), 409)).toEqual(draftRefusal);
  } finally { await home.stop(); }
}, 300_000);

test('exact Content draft refusal and identity admission refusal release their unsuccessful opener selections', async () => {
  const home = await startHomeStack('zone-realm-discussion-owner-refusals');
  try {
    const a = await arrange(home), page = await a.page('content-refusal'), key = randomUUID();
    const input = { ...a.input(page, a.author, 'Words retained after Content refusal'), language: 'x-rezics' };
    const endpoint = `/v1/realms/${local(a.realm.realm)}/about-posts`;
    const refused = await home.call('POST', endpoint, input, home.author.token, key);
    const contentRefusal = await refusal(refused, 409);
    const failed = await operation(home, a.realm.realm, page.about);
    expect(failed).toMatchObject({ phase: 'selected', terminal_refusal: true, placement_admission_id: null });
    expect((await a.effects(page.about)).threads).toBe(0);
    // Content cancellation is addressed by the native draft admission, whose
    // key is retained by Access. These are reads of owner evidence only.
    const draftAdmission = (await home.stack.accessPool.query<{ id: string }>(
      'SELECT id FROM access.admission WHERE idempotency_key=$1', [`about-post:${failed.id}:draft`])).rows[0];
    expect(draftAdmission).toBeTruthy();
    const terminal = await home.stack.content.readDraftReceipt(`content-draft:${draftAdmission!.id}`);
    expect(terminal?.outcome).toBe('cancelled');
    const oldRetry = await home.call('POST', endpoint, input, home.author.token, key);
    expect(await refusal(oldRetry, 409)).toEqual(contentRefusal);
    const fresh = await home.json<Posted>(await a.post(page, a.reader, 'A supported-language opener', home.reader.token), 201);
    expect(fresh.reply).not.toBe(failed.reply);
    expect(await refusal(await home.call('POST', endpoint, input, home.author.token, key), 409)).toEqual(contentRefusal);

    const identityPage = await a.page('identity-refusal'), identityKey = randomUUID();
    const replies = home.deps.realmReplies, original = replies.create;
    let edited: Page | undefined;
    let identityRefusal: Awaited<ReturnType<typeof refusal>> | undefined;
    replies.create = async function (...args) {
      if (!edited) edited = await editPage(home, a, identityPage);
      return original.apply(this, args);
    };
    try {
      const response = await a.post(identityPage, a.author, 'Drafted before identity refusal', home.author.token, identityKey);
      identityRefusal = await refusal(response, 403);
    } finally { replies.create = original; }
    const identityFailed = await operation(home, a.realm.realm, identityPage.about);
    expect(identityFailed).toMatchObject({ phase: 'drafted', terminal_refusal: true, placement_admission_id: null });
    expect((await a.effects(identityPage.about)).threads).toBe(0);
    await noOrphanPublicReply(home, a.realm.realm, identityFailed.reply);
    if (!edited) throw new Error('Expected the native identity basis edit');
    const winner = await home.json<Posted>(await a.post(edited, a.reader, 'Current identity basis', home.reader.token), 201);
    expect(winner.reply).not.toBe(identityFailed.reply);
    expect(await refusal(await a.post(identityPage, a.author,
      'Drafted before identity refusal', home.author.token, identityKey), 403)).toEqual(identityRefusal);
  } finally { await home.stop(); }
}, 300_000);

test('prepared-only dispatch recovers native cancellation after the attachment changes instead of stranding its key', async () => {
  const home = await startHomeStack('zone-realm-discussion-prepared-stale');
  try {
    const a = await arrange(home), page = await a.page('prepared-stale'), key = randomUUID();
    const fault = interruptAfter(home, 'preparation');
    try {
      const response = await a.post(page, a.author, 'Prepared on the old attachment', home.author.token, key);
      expect(response.status, await response.text()).toBe(503);
    } finally { fault.restore(); }
    const failed = await operation(home, a.realm.realm, page.about);
    expect(failed.placement_admission_id).toBeTruthy();
    await withdraw(home, a);
    await a.configure({ defaultRealm: a.realm.realm });
    const current = { ...page, routeRevision: (await a.route(page.path)).revision };
    const retry = await a.post(page, a.author, 'Prepared on the old attachment', home.author.token, key);
    const preparedRefusal = await refusal(retry, 409);
    expect((await a.effects(page.about)).threads).toBe(0);
    await noOrphanPublicReply(home, a.realm.realm, failed.reply);
    const prep = await home.stack.contentPool.query('SELECT status,pin_active FROM content.publication_preparation WHERE operation_id=$1',
      [failed.placement_admission_id]);
    expect(prep.rows).toEqual([{ status: 'rejected', pin_active: false }]);
    const winner = await home.json<Posted>(await a.post(current, a.reader, 'Fresh attachment basis', home.reader.token), 201);
    expect(winner.reply).not.toBe(failed.reply);
    expect(await refusal(await a.post(page, a.author,
      'Prepared on the old attachment', home.author.token, key), 409)).toEqual(preparedRefusal);
  } finally { await home.stop(); }
}, 300_000);

test('a refusal response after a graph winner retains recoverable intent and replays the committed post', async () => {
  const home = await startHomeStack('zone-realm-discussion-winner-refusal');
  try {
    const a = await arrange(home), page = await a.page('winner-refusal'), key = randomUUID();
    const replies = home.deps.realmReplies, original = replies.place;
    let fired = false;
    replies.place = async function (...args) {
      const result = await original.apply(this, args);
      if (!fired) { fired = true; throw new AdmissionDenied('Lost settlement acknowledgement'); }
      return result;
    };
    try {
      const response = await a.post(page, a.author, 'The graph owns this winner', home.author.token, key);
      expect(response.status, await response.text()).toBe(503);
      expect(fired).toBe(true);
    } finally { replies.place = original; }
    const selected = await operation(home, a.realm.realm, page.about);
    expect(selected.terminal_refusal).toBe(false);
    expect((await a.effects(page.about)).threads).toBe(1);
    expect(await acceptedPlacements(home, a.realm.realm, selected.reply)).toHaveLength(1);
    const winner = await home.json<Posted>(await a.post(page, a.author, 'The graph owns this winner', home.author.token, key), 200);
    expect(winner.reply).toBe(selected.reply);
    expect(await home.json(await a.post(page, a.author, 'The graph owns this winner', home.author.token, key), 200)).toEqual(winner);
    expect((await a.effects(page.about)).replies).toBe(1);
  } finally { await home.stop(); }
}, 300_000);


test('native placement registration refusal releases before dispatch while uncertain owner outcomes retain the same intent', async () => {
  const home = await startHomeStack('zone-realm-discussion-admission-refusal');
  try {
    const a = await arrange(home), page = await a.page('admission-refusal'), key = randomUUID();
    const owner = home.stack.access, original = owner.register;
    let revoked = false;
    let registrationRefusal: Awaited<ReturnType<typeof refusal>> | undefined;
    owner.register = async function (request, ...rest) {
      if (!revoked && request.action === 'reply.place') {
        revoked = true;
        await a.policy(a.realm.realm, 'mandatory');
      }
      return original.call(this, request, ...rest);
    };
    try {
      const response = await a.post(page, a.reader, 'Refused native registration', home.reader.token, key);
      registrationRefusal = await refusal(response, 403);
      expect(revoked).toBe(true);
    } finally { owner.register = original; }
    const refused = await operation(home, a.realm.realm, page.about);
    expect(refused).toMatchObject({ phase: 'identified', terminal_refusal: true, placement_admission_id: null });
    expect((await a.effects(page.about)).threads).toBe(0);
    await noOrphanPublicReply(home, a.realm.realm, refused.reply);
    await a.policy(a.realm.realm, 'open');
    const current = { ...page, routeRevision: (await a.route(page.path)).revision };
    const winner = await home.json<Posted>(await a.post(current, a.author, 'After registration refusal', home.author.token), 201);
    expect(winner.reply).not.toBe(refused.reply);
    expect(await refusal(await a.post(page, a.reader,
      'Refused native registration', home.reader.token, key), 403)).toEqual(registrationRefusal);

    for (const failure of [new AdmissionUnavailable('Owner unavailable'), new AdmissionConflict('Receipt differs'),
      new WorkReadLimit('Owner budget exhausted')]) {
      const pendingPage = await a.page(`uncertain-${randomUUID().slice(0, 8)}`), pendingKey = randomUUID();
      let fired = false;
      owner.register = async function (request, ...rest) {
        if (!fired && request.action === 'reply.place') { fired = true; throw failure; }
        return original.call(this, request, ...rest);
      };
      try {
        const response = await a.post(pendingPage, a.author, 'The same retained intent', home.author.token, pendingKey);
        expect(response.status, await response.text()).toBe(503);
      } finally { owner.register = original; }
      const retained = await operation(home, a.realm.realm, pendingPage.about);
      expect(retained).toMatchObject({ phase: 'identified', terminal_refusal: false, placement_admission_id: null });
      expect((await a.effects(pendingPage.about)).threads).toBe(1);
      const conflict = await a.post(pendingPage, a.author, 'Changed intent input', home.author.token, pendingKey);
      expect(conflict.status, await conflict.text()).toBe(409);
      expect((await operation(home, a.realm.realm, pendingPage.about)).terminal_refusal).toBe(false);
      const recoveredPost = await home.json<Posted>(await a.post(pendingPage, a.author,
        'The same retained intent', home.author.token, pendingKey), 201);
      expect(recoveredPost.reply).toBe(retained.reply);
      expect((await a.effects(pendingPage.about)).replies).toBe(1);
    }

    const corruptPage = await a.page('uncertain-draft-receipt'), corruptKey = randomUUID();
    const content = home.stack.content, read = content.readDraftReceipt;
    let corrupt = false;
    content.readDraftReceipt = async function (...args) {
      if (!corrupt) { corrupt = true; throw new ContentConflict('Unproved draft receipt conflict'); }
      return read.apply(this, args);
    };
    try {
      const response = await a.post(corruptPage, a.author, 'Retained after receipt conflict', home.author.token, corruptKey);
      expect(response.status, await response.text()).toBe(503);
      expect(corrupt).toBe(true);
    } finally { content.readDraftReceipt = read; }
    const retainedDraft = await operation(home, a.realm.realm, corruptPage.about);
    expect(retainedDraft).toMatchObject({ phase: 'selected', terminal_refusal: false });
    const draftWinner = await home.json<Posted>(await a.post(corruptPage, a.author,
      'Retained after receipt conflict', home.author.token, corruptKey), 201);
    expect(draftWinner.reply).toBe(retainedDraft.reply);

    const identityPage = await a.page('uncertain-identity-receipt'), identityKey = randomUUID();
    const replies = home.deps.realmReplies, create = replies.create;
    let identityConflict = false;
    replies.create = async function (...args) {
      const result = await create.apply(this, args);
      if (!identityConflict) { identityConflict = true; throw new RealmReplyConflict('Unproved identity receipt conflict'); }
      return result;
    };
    try {
      const response = await a.post(identityPage, a.author, 'Retained identity result', home.author.token, identityKey);
      expect(response.status, await response.text()).toBe(503);
    } finally { replies.create = create; }
    const retainedIdentity = await operation(home, a.realm.realm, identityPage.about);
    expect(retainedIdentity).toMatchObject({ phase: 'identified', terminal_refusal: false });
    const identityWinner = await home.json<Posted>(await a.post(identityPage, a.author,
      'Retained identity result', home.author.token, identityKey), 201);
    expect(identityWinner.reply).toBe(retainedIdentity.reply);
    expect((await a.effects(identityPage.about)).replies).toBe(1);
  } finally { await home.stop(); }
}, 300_000);
