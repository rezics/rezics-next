import { afterEach, beforeEach, expect, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  axes, empty, presentationSettingsFixture, rulesBody, scales,
  type PresentationSettingsFixture,
} from './support/growth-realm-presentation-settings-fixture.ts';

let f: PresentationSettingsFixture;
beforeEach(async () => { f = await presentationSettingsFixture(); }, 240_000);
afterEach(async () => { await f?.close(); }, 120_000);

const branches = [
  'adopt', 'clear', 'replay', 'stale', 'missing-post', 'missing-revision',
  'foreign', 'media-rollback', 'denied', 'revoked-replay', 'hidden',
] as const;

for (const axis of axes) for (const branch of branches) {
  test.serial(`native Realm settings ${branch}: independent ${axis} at ${scales.join('/')}`, async () => {
    const s = await f.select();
    const initialHead = s.head;
    const requestKey = crypto.randomUUID();
    let actor = f.base.author;
    let body: { presentation: typeof s.presentation | typeof empty } = { presentation: s.presentation };
    let expectedStatus = 200;
    let replayHead: string | undefined;
    const committed: { head: string; predecessor: string }[] = [];
    if (branch === 'revoked-replay') {
      actor = f.base.other;
      await f.manage(s, actor);
    }
    if (['clear', 'replay', 'stale', 'revoked-replay', 'hidden'].includes(branch)) {
      const adopted = await f.patch(s, body, s.head, requestKey, actor);
      expect(adopted.response.status, adopted.text).toBe(200);
      s.head = adopted.value.realm.headRevisionId;
      replayHead = s.head;
    }
    if (branch === 'clear') body = { presentation: empty };
    if (branch === 'stale') expectedStatus = 412;
    if (branch === 'missing-post' || branch === 'missing-revision') {
      const rules = { ...s.pin };
      if (branch === 'missing-post') rules.postId = newId(routeOf(s.postId)!);
      else rules.revisionId = newId(routeOf(s.postId)!);
      body = { presentation: { ...s.presentation, rules } };
      expectedStatus = 400;
    }
    if (branch === 'foreign') {
      const source = await f.call('GET', `/v1/posts/${f.base.mainTarget.postId}`);
      expect(source.response.status, source.text).toBe(200);
      body = { presentation: { ...s.presentation, rules: {
        postId: f.base.mainTarget.postId, revisionId: source.value.post.revisionId,
      } } };
      expectedStatus = 400;
    }
    if (branch === 'media-rollback') {
      body = { presentation: { ...s.presentation,
        avatarMediaId: newId(routeOf(s.realmId)!), bannerMediaId: newId(routeOf(s.realmId)!),
      } };
      expectedStatus = 409;
    }
    if (branch === 'denied') { actor = f.base.other; expectedStatus = 403; }
    if (branch === 'revoked-replay') {
      await f.manage(s, actor, true);
      expectedStatus = 403;
    }
    if (branch === 'hidden') {
      const hidden = await f.call('POST', `/v1/posts/${s.postId}:takeDown`, {
        bearer: f.base.governance.bearer, body: { reason: 'Conceal selected native rules' },
      });
      expect(hidden.response.status, hidden.text).toBe(200);
      expectedStatus = 400;
    }
    const before = await f.snapshot(s);
    await f.measure(branch, s, axis, async () => {
      const replay = branch === 'replay' || branch === 'revoked-replay';
      const head = replay || branch === 'stale' ? initialHead : s.head;
      const key = replay ? requestKey : crypto.randomUUID();
      // Observation contains the actual settings request, including source preparation,
      // native command authorization/CAS/receipt and the route's completion read.
      const result = await f.patch(s, body, head, key, actor);
      expect(result.response.status, result.text).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(result.value.realm.presentation).toEqual(body.presentation);
        if (replay) expect(result.value.realm.headRevisionId).toBe(replayHead);
        else {
          expect(result.value.realm.headRevisionId).not.toBe(head);
          committed.push({ head: result.value.realm.headRevisionId, predecessor: head });
          s.head = result.value.realm.headRevisionId;
        }
      } else {
        expect(result.value).not.toHaveProperty('realm');
        expect(result.text).not.toContain(s.post.sha256);
        if (branch === 'media-rollback') expect(result.value.code).toBe('media_unavailable');
      }
    });
    const after = await f.snapshot(s);
    expect(after).toEqual({
      head: s.head, post_head: s.postHead,
      revisions: before.revisions + committed.length + (axis === 'realm-revisions' ? scales[2] : 0),
      receipts: before.receipts + committed.length,
      events: before.events + committed.length,
    });
    // Setup and completion evidence are outside observation. Every successful native
    // request (including warmups) must have exactly its own revision, receipt and event.
    for (const command of committed) {
      const receipt = await f.db.admin.query(`SELECT r.response, o.data FROM core.receipt r
        JOIN core.outbox o USING(partition_no, epoch, position)
        WHERE r.principal_id=$1 AND r.command_kind='community.realm.update' AND r.response->>'revisionId'=$2::text`,
      [actor.accountId, command.head]);
      expect(receipt.rows).toEqual([{
        response: { realmId: s.realmId, revisionId: command.head },
        data: { realmId: s.realmId, revisionId: command.head },
      }]);
      const revision = await f.db.admin.query(`SELECT predecessor, presentation FROM community.realm_revision
        WHERE route=$1 AND realm_id=$2 AND revision_id=$3`, [routeOf(s.realmId), s.realmId, command.head]);
      expect(revision.rows).toEqual([{ predecessor: command.predecessor, presentation: body.presentation }]);
    }
    if (['adopt', 'replay', 'stale', 'hidden', 'revoked-replay'].includes(branch)) {
      const board = await f.call('GET', `/v1/boards/${s.boardId}`);
      expect(board.response.status, board.text).toBe(200);
      if (branch === 'hidden') {
        expect(board.value.board.community.rules).toEqual({ state: 'none', value: null });
        expect(board.text).not.toContain(s.pin.revisionId);
      } else {
        const rules = board.value.board.community.rules;
        expect(rules.state).toBe('available');
        expect(rules.value).toMatchObject({ ...s.pin, licence: s.post.licence, sha256: s.post.sha256 });
        expect(serializeDocument(rules.value.body)).toBe(serializeDocument(s.post.body));
      }
    }
  }, 600_000);
}

test.serial('settings reject a native rules document one canonical byte above the adoption limit', async () => {
  const s = await f.select();
  const oversized = await f.call('POST', `/v1/posts/${s.postId}/revisions`, {
    body: { body: rulesBody(65_537) }, headers: { 'if-match': JSON.stringify(s.postHead) },
  });
  expect(oversized.response.status, oversized.text).toBe(200);
  const before = await f.snapshot(s);
  const refused = await f.patch(s, { presentation: { ...empty, rules: {
    postId: s.postId, revisionId: oversized.value.post.revisionId,
  } } });
  expect(refused.response.status, refused.text).toBe(400);
  expect(await f.snapshot(s)).toEqual(before);
}, 120_000);
