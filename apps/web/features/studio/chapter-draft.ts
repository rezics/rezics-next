import { bodyInput, editorValue } from '../document-editor/body.ts';

export interface ChapterNotes { before?: string; after?: string }
export interface ChapterDraft { body: string; notes: ChapterNotes; embeds?: string[] }
const format = 'rezics-post-draft-v1';

/** One opaque autosave value binds text and both notes to the same head and retry key. */
export function chapterDraftValue(body: string, notes: ChapterNotes = {}, embeds?: string[]): string {
  return JSON.stringify({ format, body, notes: Object.fromEntries(
    (['before', 'after'] as const).flatMap(key => notes[key] === undefined ? [] : [[key, notes[key]]])),
  ...(embeds !== undefined ? { embeds } : {}) });
}

/** Older device drafts contain just the text; opening them never borrows another variant's notes. */
export function chapterDraft(value: string): ChapterDraft {
  try {
    const draft = JSON.parse(value);
    if (draft?.format === format && typeof draft.body === 'string' && draft.notes
      && (draft.embeds === undefined || Array.isArray(draft.embeds) && draft.embeds.length <= 16
        && draft.embeds.every((id: unknown) => typeof id === 'string'))
      && ['before', 'after'].every(key => draft.notes[key] === undefined || typeof draft.notes[key] === 'string')) {
      return { body: draft.body, notes: draft.notes, ...(draft.embeds !== undefined ? { embeds: draft.embeds } : {}) };
    }
  } catch { /* a legacy text/document draft */ }
  return { body: value, notes: {} };
}

/** A device copy from the text-only editor cannot clear notes it never carried. */
export function restoreChapterDraft(value: string, savedNotes: ChapterNotes, format?: 'post', embeds?: string[]): string {
  return format === 'post' && chapterDraft(value).body !== value ? value : chapterDraftValue(value, savedNotes, embeds);
}

export function chapterNoteEditors(value: unknown): ChapterNotes {
  if (!value || typeof value !== 'object') return {};
  const notes = value as Record<string, unknown>;
  return Object.fromEntries(['before', 'after'].flatMap(key => {
    const note = notes[key] as { body?: unknown; document?: unknown } | undefined;
    return typeof note?.body === 'string' ? [[key, editorValue(note.body, note.document)]] : [];
  }));
}

export function chapterDraftInput(value: string) {
  const draft = chapterDraft(value);
  return { ...bodyInput(draft.body), ...(draft.embeds !== undefined ? { embeds: draft.embeds } : {}), notes: Object.fromEntries(
    (['before', 'after'] as const).flatMap(key => draft.notes[key] === undefined ? []
      : [[key, bodyInput(draft.notes[key])]])) };
}
