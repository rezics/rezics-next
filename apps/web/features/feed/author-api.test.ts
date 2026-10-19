import { expect, test } from 'bun:test';
import { bodyText } from '../document-editor/body.ts';
import { authorFailure, type ReplyCorrection } from './author-api.ts';
import { authorFixture as f, authorTarget, authorTransport } from './author-fixtures.ts';

test('author read uses the exact object and full native Realm/reply coordinates', async () => {
  const { api, calls } = authorTransport();
  const result = await api.read(authorTarget, f.actor);
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') throw new Error('Author fixture must load');
  expect(bodyText(result.value.body)).toBe(f.body);
  expect(result.value.language).toBe('en');
  expect(calls.map(call => call.url.searchParams.get('actingSubject'))).toEqual([f.actor, f.actor, f.actor]);
  expect(decodeURIComponent(calls[1]!.url.pathname)).toContain(`/realms/${f.realm}/replies/${f.reply}`);
});

test('foreign author and a changed placement never become an editable basis', async () => {
  const foreign = authorTransport({ foreign: true });
  expect(await foreign.api.read(authorTarget, f.actor)).toEqual({ kind: 'denied' });
  expect(foreign.calls).toHaveLength(1);
  const current = authorTransport();
  expect(await current.api.read({ ...authorTarget, placement: f.nextPlacement }, f.actor)).toEqual({ kind: 'stale' });
  expect(current.calls.every(call => call.method === 'GET')).toBe(true);
});

for (const failedStep of ['draft', 'place'] as const) {
  test(`a lost ${failedStep} acknowledgement resumes the same correction after reload`, async () => {
    const { api, calls } = authorTransport({ fail: failedStep });
    const basis = await api.read(authorTarget, f.actor);
    if (basis.kind !== 'done') throw new Error('Author fixture must load');
    const intent: ReplyCorrection = { key: 'one-correction', target: authorTarget, actingSubject: f.actor,
      basis: basis.value, body: 'Corrected text in the original language.' };
    let retained = JSON.stringify(intent);
    expect(await api.correct(intent, next => { retained = JSON.stringify(next); })).toEqual({ kind: 'failed' });
    const recovered = JSON.parse(retained) as ReplyCorrection;
    const result = await api.correct(recovered, () => {});
    expect(result).toEqual({ kind: 'done', value: { reply: f.reply, revisionId: f.corrected, placement: f.nextPlacement } });
    const drafts = calls.filter(call => call.url.pathname.endsWith('/member-reply-drafts'));
    expect(drafts).toHaveLength(failedStep === 'draft' ? 2 : 1);
    expect(drafts[0]!.body).toMatchObject({ reply: f.reply, variantId: f.variant, rootTarget: f.root,
      rootRevision: f.rootRevision, originRealm: null, expectedHead: f.revision, spoiler: false, language: 'en' });
    const retried = calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith(
      failedStep === 'draft' ? '/member-reply-drafts' : '/realm-reply-placements'));
    expect(retried).toHaveLength(2);
    expect(retried[1]!.body).toEqual(retried[0]!.body);
    expect(retried[1]!.key).toBe(retried[0]!.key);
    expect(calls.some(call => call.url.pathname.endsWith('/realm-replies'))).toBe(false);
  });
}

test('withdrawal names one exact placement, replays its intent and rejects an unrelated receipt', async () => {
  const intent = { key: 'one-withdrawal', target: authorTarget, actingSubject: f.actor,
    placement: f.placement, revisionId: f.revision };
  const { api, calls } = authorTransport();
  expect(await api.withdraw(intent)).toEqual({ kind: 'done', value: { reply: f.reply, withdrawal: f.withdrawal } });
  expect(await api.withdraw(JSON.parse(JSON.stringify(intent)))).toEqual({ kind: 'done', value: { reply: f.reply, withdrawal: f.withdrawal } });
  expect(calls[1]!.body).toEqual(calls[0]!.body);
  expect(calls[1]!.key).toBe(calls[0]!.key);
  expect(calls[0]!.body).toEqual({ profile: 'realm-reply-placement-withdrawal-v1', realm: f.realm,
    reply: f.reply, expectedHead: f.placement, expectedRevisionId: f.revision, actingSubject: f.actor });
  expect(await authorTransport({ wrongReceipt: true }).api.withdraw(intent)).toEqual({ kind: 'failed' });
});

test('a receipt for another object cannot confirm a correction', async () => {
  const { api } = authorTransport({ wrongReceipt: true });
  const read = await api.read(authorTarget, f.actor);
  if (read.kind !== 'done') throw new Error('Author fixture must load');
  expect(await api.correct({ key: 'wrong-receipt', target: authorTarget, actingSubject: f.actor,
    basis: read.value, body: 'Correction.' }, () => {})).toEqual({ kind: 'failed' });
});

test('authentication, authority, stale heads, conflicting intents and unknown results stay distinct', () => {
  for (const [status, code, expected] of [
    [401, 'unauthorized', 'sign-in'], [403, 'realm_reply_denied', 'denied'],
    [409, 'realm_reply_stale', 'stale'], [409, 'idempotency_conflict', 'conflict'],
    [409, 'idempotency_pending', 'failed'], [409, 'stale_head', 'stale'],
    [404, 'reply_unavailable', 'missing'], [422, 'invalid_content', 'invalid'], [503, 'unavailable', 'failed'],
  ] as const) expect(authorFailure({ status, value: { code } })).toBe(expected);
  expect(authorFailure(null)).toBe('failed');
});
