import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { admittedOwnDraftAction, type OwnDraftReader, type OwnDraftWriteInput } from '../src/threads/own-drafts/model';
import type { RevisedPost } from '../src/threads/actions';
import { accountId, identity, mountOwnDrafts, row, selected } from './own-drafts-fixture';

test('native command advice belongs to the selected author, resource and revision', () => {
  const entry = row();
  for (const action of ['edit', 'publish', 'erase'] as const) {
    expect(admittedOwnDraftAction(entry, accountId, action)).toBe(entry.actions[action]);
    for (const replacement of [
      { ...entry, authorId: 'other-account' },
      { ...entry, revisionId: '' },
      { ...entry, id: '../another-post' },
      { ...entry, threadId: 'wrong-thread' },
      { ...entry, actions: { ...entry.actions, [action]: null } },
      { ...entry, actions: { ...entry.actions, [action]: `${entry.actions[action]}#ignored` } },
      { ...entry, actions: { ...entry.actions, [action]: `https://kernel.invalid${entry.actions[action]}` } },
    ])
      expect(admittedOwnDraftAction(replacement, accountId, action)).toBeNull();
  }
});

test('erase review retries the same uncertain intent and readback does not claim concealed erasure', async () => {
  const entry = row();
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [entry], next: null }),
    resume: async () => selected(entry),
  };
  const erasures: unknown[] = [];
  let eraseAttempt = 0;
  const fixture = await mountOwnDrafts();
  try {
    await fixture.render({
      identity,
      active: true,
      reader,
      commands: {
        async write() {
          return { ok: false, reason: 'unavailable' };
        },
        async erase(input) {
          erasures.push(structuredClone(input));
          eraseAttempt++;
          return eraseAttempt === 1 ? { ok: false, reason: 'unavailable' } : { ok: true };
        },
        async readback() {
          return 'concealed';
        },
      },
    });
    await fixture.click('Inspect draft privately');
    expect(erasures).toHaveLength(0);
    await fixture.click('Erase draft');
    expect(fixture.host.querySelector('[role="alertdialog"]')?.textContent).toContain('Review draft erasure');
    expect(erasures).toHaveLength(0);
    await fixture.click('Confirm erase');
    expect(fixture.host.textContent).toContain('Retry the same erase');
    const exactIntent = structuredClone(erasures[0]);
    await fixture.click('Retry the same erase');
    expect(erasures).toHaveLength(2);
    expect(erasures[1]).toEqual(exactIntent);
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('That does not confirm erasure');
    expect(fixture.host.textContent).not.toContain('The draft was erased');
  } finally {
    await fixture.close();
  }
});

test('publish sends the selected revision and separates acknowledgement from published readback', async () => {
  const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
  const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
  const entry = row({ mediaIds: [mediaId], subjectIds: [subjectId], language: 'ja', licence: 'CC-BY-4.0' });
  const body = fromPlainText('Published current body', 'blocks');
  const inspected = selected(entry);
  const editorBody = {
    ...inspected.post.body,
    doc: {
      ...inspected.post.body.doc,
      content: [
        ...inspected.post.body.doc.content!,
        { type: 'image' as const, attrs: { id: 'retained-image', src: mediaId, alt: 'Retained image' } },
      ],
    },
  };
  const fixture = await mountOwnDrafts();
  const writes: OwnDraftWriteInput[] = [];
  let visibility: 'draft' | 'published' = 'draft';
  let firstPublish = true;
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [entry], next: null }),
    resume: async () => ({ ...inspected, post: { ...inspected.post, body: editorBody } }),
  };
  try {
    await fixture.render({
      identity,
      active: true,
      reader,
      commands: {
        async write(input) {
          writes.push(input);
          if (input.action === 'publish' && firstPublish) {
            firstPublish = false;
            return { ok: false, reason: 'unavailable' };
          }
          if (input.action === 'publish') visibility = 'published';
          return { ok: true, post: {} as unknown as RevisedPost };
        },
        async erase() {
          return { ok: true };
        },
        async readback() {
          return {
            state: 'available',
            revision: visibility === 'published' ? 'published-revision' : 'saved-revision',
            visibility,
            body,
            mediaIds: [],
          };
        },
      },
    });
    await fixture.click('Inspect draft privately');
    await fixture.click('Use server-saved body in editor');
    expect(fixture.host.textContent).toContain(entry.id);
    expect(fixture.host.textContent).toContain(entry.threadId);
    expect(fixture.host.textContent).toContain(entry.licence);
    expect(fixture.host.textContent).toContain(entry.revisionId);
    expect(fixture.host.textContent).toContain(subjectId);
    expect(fixture.host.textContent).toContain('ja');
    await fixture.click('Save changes');
    expect(writes[0]).toMatchObject({
      action: 'save',
      postId: entry.id,
      threadId: entry.threadId,
      revisionId: entry.revisionId,
    });
    expect(fixture.host.textContent).toContain('The save request was acknowledged');
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('retained draft at revision saved-revision');
    await fixture.click('Restart inventory');
    await fixture.click('Inspect draft privately');
    await fixture.click('Use server-saved body in editor');
    await fixture.click('Publish');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      action: 'publish',
      postId: entry.id,
      threadId: entry.threadId,
      revisionId: entry.revisionId,
      mediaIds: [mediaId],
    });
    expect(writes[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(fixture.host.textContent).toContain('Retry publish');
    await fixture.click('Retry publish');
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual(writes[1]);
    expect(fixture.host.textContent).toContain('The publish request was acknowledged');
    expect(fixture.host.textContent).not.toContain('published post at revision');
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('published post at revision published-revision');
    expect(fixture.host.textContent).toContain('Published current body');
  } finally {
    await fixture.close();
  }
});
