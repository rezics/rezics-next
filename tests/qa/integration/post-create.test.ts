import { expect, test } from 'bun:test';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';

test('A member can publish a titled, Work attached community post and read its exact placement', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    const selected = await h.call('GET', `/v1/main-versions/${h.work.mainVersion.slice(-36)}/selection?language=en`);
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    expect(selected.body.selectedDraft).toBe(h.first.draftRevision);
    const post = await h.reply();
    const body = 'Spoilers: A story about the ending\nWhat did you think of the final chapter?';
    const authored = await h.call('POST', '/v1/member-reply-drafts', { ...post.input,
      expectedHead: post.draft.body.revisionId, body });
    expect(authored.status, JSON.stringify(authored.body)).toBe(201);
    const publicReply = await h.call('GET', post.path);
    expect(publicReply.status, JSON.stringify(publicReply.body)).toBe(404);
    const placed = await h.call('POST', '/v1/realm-reply-placements', { ...post.placement,
      revisionId: authored.body.revisionId,
      revisionDigest: (await h.contentPool.query<{ byte_digest: string }>(
        'SELECT byte_digest FROM content.revision WHERE id=$1', [authored.body.revisionId])).rows[0]!.byte_digest });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const visible = await h.call('GET', post.path);
    expect(visible.status, JSON.stringify(visible.body)).toBe(200);
    expect(visible.body).toMatchObject({ body, author: h.actor, rootTarget: h.work.work,
      originRealm: h.realm, revisionId: authored.body.revisionId });
    expect((await h.replies.visible(h.realm, post.input.reply))?.revisionId).toBe(authored.body.revisionId);
    expect((await h.call('POST', '/v1/realm-reply-placements', { ...post.placement,
      revisionId: authored.body.revisionId,
      revisionDigest: visible.body.revisionDigest }, h.actor, 'replay-placement')).status).toBe(409);
  } finally { await h.close(); }
}, 180_000);
