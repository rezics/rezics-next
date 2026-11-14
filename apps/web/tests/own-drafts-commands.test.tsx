import { expect, test } from 'bun:test';
import { fromMarkdown, fromPlainText } from '@rezics/document';
import { act } from 'react';
import { prepareWriting } from '../src/threads/local-writing-draft';
import { admittedOwnDraftAction, type OwnDraftReader, type OwnDraftWriteInput } from '../src/threads/own-drafts/model';
import type { RevisedPost } from '../src/threads/actions';
import { accountId, footnoteDocument, identity, mountOwnDrafts, row, selected } from './own-drafts-fixture';

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
    list: async ({ cursor }) => ({
      state: 'ready',
      viewer: { accountId, authnEpoch: 2 },
      drafts: cursor ? [row({ id: 'older-draft', title: 'Older draft' })] : [entry],
      next: cursor ? null : 'older',
    }),
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
    await fixture.click('Cancel');
    expect(fixture.window.document.activeElement?.textContent).toBe('Erase draft');
    expect(erasures).toHaveLength(0);
    await fixture.click('Erase draft');
    await fixture.click('Confirm erase');
    await fixture.click('Return to drafts');
    expect(fixture.window.document.activeElement?.textContent).toBe('Inspect draft privately');
    expect(fixture.host.textContent).toContain('Retry the same erase');
    await fixture.click('Inspect draft privately');
    expect(fixture.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(erasures).toHaveLength(1);
    const exactIntent = structuredClone(erasures[0]);
    await fixture.click('Retry the same erase');
    expect(erasures).toHaveLength(2);
    expect(erasures[1]).toEqual(exactIntent);
    expect(fixture.window.document.activeElement?.textContent).toContain('The erase request was acknowledged');
    await fixture.click('Retry this page');
    expect(fixture.host.textContent).toContain('The erase request was acknowledged');
    await fixture.click('Continue to older drafts');
    expect(fixture.host.textContent).toContain('The erase request was acknowledged');
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('That does not confirm erasure');
    expect(fixture.host.textContent).not.toContain('The draft was erased');
  } finally {
    await fixture.close();
  }
});

test('server and browser footnotes survive explicit source submission and later current readback', async () => {
  const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
  const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
  const entry = row({ mediaIds: [mediaId], subjectIds: [subjectId], language: 'ja', licence: 'CC-BY-4.0' });
  const body = fromMarkdown(
    '## Published current body\n\n> Current quotation\n\n- Current list item\n\nBefore >!Current secret!< after.\n\n```ts\nconst current = true;\n```\n\nSee [^Current-1].\n\n[^Current-1]: Current citation',
    'blocks',
  );
  const inspected = selected(entry);
  inspected.post.body = footnoteDocument('Server-1', 'Server supplied citation');
  const browserWriting = {
    slot: 0,
    actor: accountId,
    scope: { kind: 'thread' as const, boardId: entry.board.id, subjects: [] },
    revision: 'browser-local-revision',
    updated: 1_798_000_000_000,
    bytes: 0,
    state: 'unsent' as const,
    payload: prepareWriting('Browser-only title', footnoteDocument('Browser-1', 'Browser supplied citation')),
  };
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
      localWritingReader: { load: async () => browserWriting },
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
    expect(fixture.host.textContent).toContain('Footnote Server-1');
    expect(fixture.host.textContent).toContain('Footnote Browser-1');
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
    expect(JSON.stringify(writes[0]?.body)).toContain('"type":"footnoteReference"');
    expect(JSON.stringify(writes[0]?.body)).toContain('"type":"footnoteDefinition"');
    expect(JSON.stringify(writes[0]?.body)).toContain('"label":"Server-1"');
    expect(fixture.host.textContent).toContain('The save request was acknowledged');
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('retained draft at revision saved-revision');
    expect(fixture.host.querySelector('article h2')?.textContent).toBe('Published current body');
    expect(fixture.host.querySelector('article blockquote')?.textContent).toBe('Current quotation');
    expect(fixture.host.querySelector('article ul li')?.textContent).toBe('Current list item');
    expect(fixture.host.querySelector('article pre code')?.textContent).toContain('const current = true;');
    expect(fixture.host.querySelector('article [data-slot="document-footnotes"] summary')?.textContent).toContain(
      'Footnote Current-1',
    );
    const savedHeading = fixture.host.querySelector('article h2')?.id;
    expect(savedHeading).toBeTruthy();
    await fixture.click('Reveal spoiler');
    expect(fixture.host.querySelector('article .document-spoiler-revealed')?.textContent).toBe('Current secret');
    await fixture.click('Restart inventory');
    await fixture.click('Inspect draft privately');
    expect(fixture.host.textContent).toContain('Footnote Browser-1');
    await fixture.click('Use browser-saved body in editor');
    await fixture.click('Publish');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      action: 'publish',
      postId: entry.id,
      threadId: entry.threadId,
      revisionId: entry.revisionId,
      mediaIds: [],
    });
    expect(JSON.stringify(writes[1]?.body)).toContain('"type":"footnoteReference"');
    expect(JSON.stringify(writes[1]?.body)).toContain('"type":"footnoteDefinition"');
    expect(JSON.stringify(writes[1]?.body)).toContain('"label":"Browser-1"');
    expect(writes[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(fixture.host.textContent).toContain('Retry publish');
    const { m } = await import('../src/paraglide/messages.js');
    await fixture.click('Return to drafts');
    expect(fixture.window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      m.thread_authoring_leave_pending(),
    );
    await fixture.click(m.thread_authoring_stay());
    expect(fixture.host.textContent).toContain('Retry publish');
    await fixture.click('Retry publish');
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual(writes[1]);
    expect(fixture.host.textContent).toContain('The publish request was acknowledged');
    expect(fixture.host.textContent).not.toContain('published post at revision');
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('published post at revision published-revision');
    expect(fixture.host.textContent).toContain('Published current body');
    const currentDetails = fixture.host.querySelector(
      'article [data-slot="document-footnotes"] details',
    ) as HTMLDetailsElement;
    await act(async () => {
      currentDetails.open = true;
      currentDetails.dispatchEvent(new fixture.window.Event('toggle'));
    });
    const currentFootnotes = fixture.host.querySelector('article [data-slot="document-footnotes"]');
    expect(currentFootnotes?.textContent).toContain('Current citation');
    expect(currentFootnotes?.textContent).not.toContain('Server supplied citation');
    expect(currentFootnotes?.textContent).not.toContain('Browser supplied citation');
    expect(fixture.host.querySelector('article h2')?.id).not.toBe(savedHeading);
    expect(fixture.host.querySelector('article .document-spoiler-revealed')).toBeNull();
    expect(fixture.host.querySelector('article [data-slot="post-reading-body"]')?.getAttribute('lang')).toBe('');
    expect(fixture.host.textContent).toContain(entry.title!);
    expect(fixture.host.querySelector('time')?.dateTime).toBe(entry.savedAt);
  } finally {
    await fixture.close();
  }
});

test('a changed native credential epoch retires private command readback', async () => {
  const entry = row();
  let authnEpoch = 2;
  const currentBody = fromPlainText('Private readback from the old credential', 'blocks');
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch }, drafts: [entry], next: null }),
    resume: async () => selected(entry),
  };
  const fixture = await mountOwnDrafts();
  try {
    await fixture.render({
      identity: { ...identity, authnEpoch: null },
      active: true,
      reader,
      commands: {
        async write() {
          return { ok: true, post: {} as unknown as RevisedPost };
        },
        async erase() {
          return { ok: true };
        },
        async readback() {
          return {
            state: 'available',
            revision: 'current-revision',
            visibility: 'draft',
            body: currentBody,
            mediaIds: [],
          };
        },
      },
    });
    await fixture.click('Inspect draft privately');
    await fixture.click('Use server-saved body in editor');
    await fixture.click('Save changes');
    await fixture.click('Read current post');
    expect(fixture.host.textContent).toContain('Private readback from the old credential');

    authnEpoch = 3;
    await fixture.click('Retry this page');
    expect(fixture.host.textContent).toContain('This private inventory is unavailable for the current account.');
    expect(fixture.host.textContent).not.toContain('Private readback from the old credential');
  } finally {
    await fixture.close();
  }
});
