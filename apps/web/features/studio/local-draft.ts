/**
 * Text kept on this device until Main has saved it: written on every change, so
 * a closed tab, a crash or a lost connection never loses typing. `base` is the
 * draft head the text was written on; a different head on Main means someone
 * saved meanwhile and the writer chooses (see `restoreDecision`).
 */
import { parseStoredDocument } from '@rezics/document';
import { restoreCachedBody } from '../document-editor/body.ts';

export interface LocalDraft {
  body: string;
  base: string | null;
  changedAt: string;
  format?: 'document';
}

/** Storage the browser offers; a test or a private window may lack it. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PREFIX = 'rezics:studio:draft:';

/** One key per Studio Agent and text: two Agents never share a device copy. */
export const localDraftKey = (agent: string, resource: string, variant: string) =>
  `${PREFIX}${agent.slice(-36)}:${resource.slice(-36)}:${variant.slice(-36)}`;

export function readLocalDraft(storage: DraftStorage | null, key: string): LocalDraft | null {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as Partial<LocalDraft> | null;
    if (
      typeof value?.body !== 'string' ||
      (value.base !== null && typeof value.base !== 'string') ||
      typeof value.changedAt !== 'string'
    )
      return null;
    return {
      body: restoreCachedBody(value.body, value.format),
      base: value.base,
      changedAt: value.changedAt,
    };
  } catch {
    return null;
  }
}

/** Keeps the text; false when the device refused (quota or a disabled store). */
export function writeLocalDraft(
  storage: DraftStorage | null,
  key: string,
  draft: LocalDraft,
): boolean {
  try {
    storage?.setItem(
      key,
      JSON.stringify({
        ...draft,
        ...(parseStoredDocument(draft.body) ? { format: 'document' } : {}),
      }),
    );
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function clearLocalDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* nothing kept, nothing to clear */
  }
}

export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * What to open with, given Main's draft head and the device copy: Main's text,
 * the device text on the same head (unsaved typing to save now), or a conflict
 * when Main moved past the head the device text was written on.
 */
export function restoreDecision(
  server: { head: string | null; body: string },
  local: LocalDraft | null,
): { kind: 'server' } | { kind: 'restore'; body: string } | { kind: 'conflict'; mine: string } {
  if (!local || local.body === server.body) return { kind: 'server' };
  if (local.base === server.head) return { kind: 'restore', body: local.body };
  return { kind: 'conflict', mine: local.body };
}

/**
 * What this device learned about one chapter variant from its own saves and
 * publications. Main does not yet let a writer read a variant's heads, so the
 * editor starts from these on the device that wrote them; elsewhere the first
 * save meets the head that won as a conflict, and publishing an update needs
 * the publication this device made.
 */
export interface ChapterMemory {
  head: string | null;
  /** The saved bytes' digest and Content epoch at `head`, which a publication names. */
  digest: string | null;
  epoch: string | null;
  publication: string | null;
  eligibility: string | null;
  /** The draft head that `publication` published. */
  publishedHead: string | null;
  /** The draft's length in its language's unit (see `manuscriptLength`). */
  length: number | null;
  savedAt: string | null;
}

const MEMORY_PREFIX = 'rezics:studio:chapter:';
const emptyMemory: ChapterMemory = {
  head: null,
  digest: null,
  epoch: null,
  publication: null,
  eligibility: null,
  publishedHead: null,
  length: null,
  savedAt: null,
};

/** One key per Studio Agent and chapter variant. */
export const chapterMemoryKey = (agent: string, variant: string) =>
  `${MEMORY_PREFIX}${agent.slice(-36)}:${variant.slice(-36)}`;

export function readChapterMemory(storage: DraftStorage | null, key: string): ChapterMemory | null {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as Partial<ChapterMemory> | null;
    if (typeof value !== 'object' || value === null) return null;
    const text = (name: keyof ChapterMemory) =>
      typeof value[name] === 'string' ? (value[name] as string) : null;
    return {
      head: text('head'),
      digest: text('digest'),
      epoch: text('epoch'),
      publication: text('publication'),
      eligibility: text('eligibility'),
      publishedHead: text('publishedHead'),
      savedAt: text('savedAt'),
      length:
        typeof value.length === 'number' && Number.isFinite(value.length) ? value.length : null,
    };
  } catch {
    return null;
  }
}

/** Merges what the device just learned into what it knew. */
export function rememberChapter(
  storage: DraftStorage | null,
  key: string,
  patch: Partial<ChapterMemory>,
): ChapterMemory {
  const next = { ...emptyMemory, ...readChapterMemory(storage, key), ...patch };
  try {
    storage?.setItem(key, JSON.stringify(next));
  } catch {
    /* the device keeps nothing; Main still holds the text */
  }
  return next;
}
