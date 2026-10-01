import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';

test('G-902 draft digests survive retries, later edits and tombstones', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    const input = { ...h.draftInput(), body: '讨论 النهاية 🌍' };
    const key = randomUUID();
    const created = await h.call('POST', '/v1/member-reply-drafts', input, h.actor, key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body).toMatchObject({ deleted: false, replayed: false, predecessor: null });
    const retry = await h.call('POST', '/v1/member-reply-drafts', input, h.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toEqual({ ...created.body, replayed: true });

    const editInput = { ...input, expectedHead: created.body.revisionId, body: 'Revised discussion' };
    const editKey = randomUUID();
    const edited = await h.call('POST', '/v1/member-reply-drafts', editInput, h.actor, editKey);
    expect(edited.status, JSON.stringify(edited.body)).toBe(201);
    expect(edited.body.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(edited.body.revisionDigest).not.toBe(created.body.revisionDigest);
    expect(edited.body.predecessor).toBe(created.body.revisionId);

    const oldRetry = await h.call('POST', '/v1/member-reply-drafts', input, h.actor, key);
    expect(oldRetry.status, JSON.stringify(oldRetry.body)).toBe(200);
    expect(oldRetry.body).toEqual({ ...created.body, replayed: true });
    const stale = await h.call('POST', '/v1/member-reply-drafts', editInput);
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.revisionDigest).toBeUndefined();

    const deletedInput = { ...input, expectedHead: edited.body.revisionId, body: null };
    const deleteKey = randomUUID();
    const deleted = await h.call('POST', '/v1/member-reply-drafts', deletedInput, h.actor, deleteKey);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(201);
    expect(deleted.body).toMatchObject({ deleted: true, predecessor: edited.body.revisionId });
    expect(deleted.body.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(deleted.body.revisionDigest).not.toBe(edited.body.revisionDigest);
    const deleteRetry = await h.call('POST', '/v1/member-reply-drafts', deletedInput, h.actor, deleteKey);
    expect(deleteRetry.status, JSON.stringify(deleteRetry.body)).toBe(200);
    expect(deleteRetry.body).toEqual({ ...deleted.body, replayed: true });
    const editRetry = await h.call('POST', '/v1/member-reply-drafts', editInput, h.actor, editKey);
    expect(editRetry.status, JSON.stringify(editRetry.body)).toBe(200);
    expect(editRetry.body).toEqual({ ...edited.body, replayed: true });
  } finally { await h.close(); }
}, 180_000);
