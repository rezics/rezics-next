import { expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { chapterDraft, chapterDraftInput, chapterDraftValue, restoreChapterDraft } from '../features/studio/chapter-draft.ts';
import { DraftAutosave } from '../features/studio/autosave.ts';
import { chapterVariant, readChapterRevision, saveChapterDraft } from '../features/studio/content-api.ts';
import { agents, ids, storyMain } from '../features/studio/fixtures.ts';
import { readLocalDraft, writeLocalDraft, type DraftStorage } from '../features/studio/local-draft.ts';

test('A chapter draft preserves portable documents for all three parts and old device drafts still open as text', () => {
  const before = serializeDocument(fromPlainText('Before'));
  const body = serializeDocument(fromPlainText('Chapter'));
  const value = chapterDraftValue(body, { before, after: 'After' });
  expect(chapterDraft(value)).toEqual({ body, notes: { before, after: 'After' } });
  expect(chapterDraftInput(value)).toEqual({ document: fromSnapshot(body),
    notes: { before: { document: fromSnapshot(before) }, after: { body: 'After' } } });
  expect(chapterDraft('Old chapter text')).toEqual({ body: 'Old chapter text', notes: {} });
  expect(chapterDraft(body)).toEqual({ body, notes: {} });
  expect(chapterDraft(restoreChapterDraft('Legacy unsaved text', { after: 'Saved note' })))
    .toEqual({ body: 'Legacy unsaved text', notes: { after: 'Saved note' } });
  expect(restoreChapterDraft(value, { after: 'Other note' }, 'post')).toBe(value);
  // A legacy authored JSON string is text even when it resembles our internal envelope.
  expect(chapterDraft(restoreChapterDraft(value, {}))).toEqual({ body: value, notes: {} });
  const items = new Map<string, string>();
  const storage: DraftStorage = { getItem: key => items.get(key) ?? null,
    setItem: (key, next) => { items.set(key, next); }, removeItem: key => { items.delete(key); } };
  writeLocalDraft(storage, 'chapter', { body: value, base: 'head', changedAt: 'now', format: 'post' });
  expect(readLocalDraft(storage, 'chapter')?.body).toBe(value);
  expect(readLocalDraft(storage, 'chapter')?.format).toBe('post');
  // Editing a note must also retain the text's existing disclosure dependencies.
  const embeds = ['00000000-0000-4000-8000-000000000001'];
  expect(chapterDraftInput(chapterDraftValue(body, { after: 'Note only edit' }, embeds)))
    .toMatchObject({ document: fromSnapshot(body), embeds });
});
const fromSnapshot = (value: string) => JSON.parse(value);

test('A lost save retries the same text and notes with the same key before saving newer notes', async () => {
  const attempts: Array<{ body: string; head: string | null; key: string }> = [];
  const initial = chapterDraftValue('Chapter', {});
  const first = chapterDraftValue('Chapter', { before: 'First before', after: 'First after' });
  const next = chapterDraftValue('Chapter', { before: 'First before', after: 'New after' });
  const autosave = new DraftAutosave({ head: 'h0', body: initial, delay: 60_000,
    keep: () => {}, release: () => {}, save: async (body, head, key) => {
      attempts.push({ body, head, key });
      return attempts.length === 1 ? { kind: 'offline' } : { kind: 'saved', head: `h${attempts.length}` };
    } });
  try {
    autosave.edit(first);
    await autosave.flush();
    autosave.edit(next);
    await autosave.flush();
    expect(attempts[1]).toEqual(attempts[0]);
    await autosave.flush();
    expect(attempts[2]?.body).toBe(next);
    expect(attempts[2]?.head).toBe('h2');
    expect(attempts[2]?.key).not.toBe(attempts[0]?.key);
    expect(autosave.snapshot.saved).toBe(next);
  } finally { autosave.dispose(); }
});

test('Exact Studio reads preserve notes only in their saved language variant; removing notes saves their absence', async () => {
  const story = storyMain({ delayMs: 0 });
  const chapter = ids.chapters[0]!;
  for (const language of ['en', 'zh-Hant']) {
    const variant = await chapterVariant(chapter, language);
    const target = { chapter, variant, language, direction: 'ltr' as const, actingSubject: agents[0]!.iri };
    let head = '';
    const notes = language === 'en' ? { before: 'Author before', after: 'Author after' } : {};
    expect(await saveChapterDraft(target, chapterDraftValue(`Text ${language}`, notes), null, `save-${language}`,
      saved => { head = saved.head; }, story.main)).toEqual({ kind: 'saved', head });
    const read = await readChapterRevision(target.actingSubject, head, story.main);
    const draft = { body: read!.body, notes: read!.notes };
    const input = chapterDraftInput(chapterDraftValue(draft.body, draft.notes));
    expect(draft.body).toContain(`Text ${language}`);
    expect(Object.keys(draft.notes)).toEqual(language === 'en' ? ['before', 'after'] : []);
    if (language === 'en') {
      expect(input.notes.before).toHaveProperty('document');
      expect(await saveChapterDraft(target, chapterDraftValue(draft.body), head, 'remove-notes',
        saved => { head = saved.head; }, story.main)).toEqual({ kind: 'saved', head });
      expect((await readChapterRevision(target.actingSubject, head, story.main))!.notes).toEqual({});
    }
  }
});
