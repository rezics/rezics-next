import { browserMainApi } from '../api/browser.ts';
import type { SaveOutcome } from './autosave.ts';
import { idOf, type MainClient } from './types.ts';

// The browser side of a Book's chapters: the Book's composition orders them,
// each chapter is a Work of its own, and its text is a Content draft in one
// language (`content-text-v1`), published as a Content publication that
// readers can open once it is also eligible for public search. Every command
// acts as the Studio Agent and carries its own idempotency key.

type Failure = { status: number; value?: unknown };

const field = (error: Failure, name: string) => (typeof error.value === 'object' && error.value !== null
  && name in error.value ? (error.value as Record<string, unknown>)[name] : undefined);
const code = (error: Failure) => String(field(error, 'code') ?? '');
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Main's answer to a save, as the autosave machine reacts to it; a stale head names the head that won. */
export function saveOutcomeOf(error: Failure): SaveOutcome {
  // No HTTP status: the request never got an answer (the network failed under it).
  if (!(error.status >= 100)) return { kind: 'offline' };
  if (error.status === 409 && code(error) !== 'idempotency_conflict') {
    const head = field(error, 'currentHead');
    return { kind: 'conflict', head: typeof head === 'string' ? head : null };
  }
  if (error.status === 401 || error.status === 403) return { kind: 'denied' };
  if (error.status === 408 || error.status === 429 || error.status >= 500) return { kind: 'failed', retryable: true };
  return { kind: 'failed', retryable: false };
}

/**
 * The variant that holds a chapter's text in one language. Main takes the
 * variant ID from its writer, so Studio derives it from the chapter and the
 * language: every device writes the same variant without having to read it.
 */
export async function chapterVariant(chapter: string, language: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`rezics:studio:chapter-variant:v1\0${chapter}\0${language.toLowerCase()}`)));
  const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  // RFC 9562 UUIDv8 (custom, name-based) with the RFC variant bits.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `urn:rezics:variant:${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${
    hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ChapterTarget {
  actingSubject: string;
  /** The chapter Work. */
  chapter: string;
  variant: string;
  language: string;
  direction: 'ltr' | 'rtl';
}

/** What a save leaves for publishing: the exact bytes Main keeps and the Content owner epoch they belong to. */
export interface DraftBasis { head: string; digest: string; epoch: string }

/** Saves a chapter draft on `expectedHead` (null for its first save); `onSaved` receives what publishing needs. */
export async function saveChapterDraft(target: ChapterTarget, body: string, expectedHead: string | null, key: string,
  onSaved: (basis: DraftBasis) => void, main: MainClient = browserMainApi()): Promise<SaveOutcome> {
  if (offline()) return { kind: 'offline' };
  const saved = await main.v1['content-drafts'].post({ profile: 'content-text-v1', resourceId: target.chapter,
    variantId: target.variant, language: { kind: 'tag', tag: target.language, originalTag: target.language },
    direction: target.direction, expectedHead, body, actingSubject: target.actingSubject },
  { headers: { 'idempotency-key': key } });
  if (saved.error) return saveOutcomeOf(saved.error);
  if (!saved.data || 'operationId' in saved.data) return { kind: 'failed', retryable: true };
  onSaved({ head: saved.data.revisionId, digest: saved.data.byteDigest, epoch: saved.data.sourcePosition.dataEpoch });
  return { kind: 'saved', head: saved.data.revisionId };
}

/** One exact chapter revision's text, or null when Main cannot give it to this Agent. */
export async function readChapterRevision(actingSubject: string, revision: string,
  main: MainClient = browserMainApi()): Promise<{ body: string; digest: string } | null> {
  if (!uuid.test(revision)) return null;
  const read = await main.v1['content-revisions']({ revision }).get({ query: { actingSubject } });
  const body = read.data?.body.body;
  return read.data && typeof body === 'string' ? { body, digest: read.data.reference.byteDigest } : null;
}

export type PublishOutcome = 'done' | 'denied' | 'stale' | 'pending' | 'failed';

export interface ChapterPublication {
  /** The Content publication decision now current; the next update names it as its expected head. */
  publication: string;
  /** The public search eligibility now current; readers open a chapter only while it names `publication`. */
  eligibility: string | null;
}

/**
 * Publishes the draft at `basis.head` and makes it readable: a Content
 * publication, then public search eligibility for that publication. An update
 * names the current publication and eligibility it replaces; a stale one is
 * refused rather than overwriting a publication made elsewhere.
 */
export async function publishChapter(input: { target: ChapterTarget; basis: DraftBasis; current: ChapterPublication | null;
  key: string }, main: MainClient = browserMainApi()): Promise<{ outcome: PublishOutcome; step: 'publish' | 'eligibility';
  publication?: ChapterPublication }> {
  const { target, basis } = input;
  const published = await main.v1['content-publications'].post({ profile: 'content-publication-v1',
    // One preparation per exact revision: a retry of this publication resends it and replays.
    preparationId: `studio:${idOf(target.chapter)}:${basis.head}`, revisionId: basis.head, expectedDigest: basis.digest,
    expectedContentEpoch: basis.epoch, resourceId: target.chapter, variantId: target.variant,
    expectedPublicationHead: input.current?.publication ?? null, actingSubject: target.actingSubject },
  { headers: { 'idempotency-key': `${input.key}:publish` } });
  if (published.error) {
    const status = published.error.status;
    return { step: 'publish', outcome: status === 401 || status === 403 ? 'denied' : status === 409 ? 'stale' : 'failed' };
  }
  const result = published.data;
  if (!result || 'operationId' in result || result.status === 'pending') return { step: 'publish', outcome: 'pending' };
  // Main answers `rejected` when the publication head moved (or an embed was refused) and says no more.
  if (result.status === 'rejected' || !result.decision) return { step: 'publish', outcome: 'stale' };
  const publication = result.decision;
  const eligible = await main.v1['content-search-eligibility'].post({ profile: 'content-search-eligibility-v1',
    resourceId: target.chapter, variantId: target.variant, publicationDecision: publication,
    expectedEligibilityHead: input.current?.eligibility ?? null, actingSubject: target.actingSubject,
    rightsBasis: 'original-contribution', disclosure: 'public' }, { headers: { 'idempotency-key': `${input.key}:eligibility` } });
  if (eligible.error || !eligible.data || 'operationId' in eligible.data || !eligible.data.decision) {
    const status = eligible.error?.status ?? 0;
    return { step: 'eligibility', publication: { publication, eligibility: null },
      outcome: status === 401 || status === 403 ? 'denied' : status === 409 ? 'stale' : eligible.error ? 'failed' : 'pending' };
  }
  return { step: 'eligibility', outcome: 'done', publication: { publication, eligibility: eligible.data.decision } };
}

type Refusal = 'stale' | 'denied' | 'failed' | 'pending';

/**
 * Sends a command until Main answers it: a 202 means Main is still settling a
 * command with this key, and the same request (same key) later answers with its
 * result. A few seconds bound the wait; after that the caller reports pending.
 */
export async function settled<T extends { data: unknown }>(send: () => Promise<T>, attempts = 6): Promise<T> {
  let answer = await send();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const data = answer.data as { operationId?: unknown; retry?: { afterMs?: unknown } } | null;
    if (!data || typeof data !== 'object' || !('operationId' in data)) return answer;
    const after = typeof data.retry?.afterMs === 'number' ? data.retry.afterMs : 1_000;
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(after, 250), 2_000)));
    answer = await send();
  }
  return answer;
}
export type ChapterCommand = { outcome: 'done'; head: string } | { outcome: Refusal };

const commandOf = (error: Failure): Refusal => error.status === 401 || error.status === 403 ? 'denied'
  : error.status === 409 && code(error) !== 'idempotency_conflict' ? 'stale' : 'failed';

/** The Book's composition and its current head, or null when it has none yet. */
export async function readCompositionHead(actingSubject: string, book: string, language: string | undefined,
  main: MainClient = browserMainApi()): Promise<{ structure: string; head: string } | null | 'unavailable'> {
  const read = await main.v1.works({ id: idOf(book) }).contents.get({ query: { actingSubject, limit: 1,
    ...(language ? { language } : {}) } });
  if (read.data) return { structure: read.data.composition, head: read.data.compositionRevision };
  return read.error?.status === 404 ? null : 'unavailable';
}

/**
 * Adds a chapter at the end of a Book: the Book's composition first when it has
 * none, then the chapter's Work, then its place in the composition. The chapter
 * is created as its writer's own Work (`POST /v1/works`) rather than through
 * `POST /v1/works/{id}/chapters`, because Main grants a writer authority over
 * the Works they create and not (yet) over chapters that command creates for
 * them. Each step keeps its key, so a retry replays instead of adding a second
 * chapter; the placement's key names the head it was made on.
 */
export async function createChapter(input: { actingSubject: string; book: string; mainVersion: string;
  composition: { structure: string; head: string } | null; title: string; language: string; key: string },
main: MainClient = browserMainApi()): Promise<ChapterCommand & { chapter?: string; structure?: string;
  /** The chapter's place in the composition, when Main's answer names it (a replayed answer may not). */
  occurrence?: string }> {
  const headers = (step: string) => ({ headers: { 'idempotency-key': `${input.key}:${step}` } });
  const composition = input.composition ?? await (async (): Promise<{ structure: string; head: string } | Refusal> => {
    const created = await settled(() => main.v1.compositions.post({ profile: 'book-composition', work: input.book,
      mainVersion: input.mainVersion, actingSubject: input.actingSubject }, headers('composition')));
    if (created.data && !('operationId' in created.data) && created.data.revision) {
      return { structure: created.data.structure, head: created.data.revision };
    }
    if (!created.error) return 'pending';
    // Another tab made the composition first: read it and carry on.
    const found = created.error.status === 409
      ? await readCompositionHead(input.actingSubject, input.book, input.language, main) : null;
    return found && found !== 'unavailable' ? found : commandOf(created.error);
  })();
  if (typeof composition === 'string') return { outcome: composition };
  const { structure } = composition;
  const work = await settled(() => main.v1.works.post({ profile: 'metadata-only-v1', title: input.title,
    language: input.language, authoring: 'own-work', actingSubject: input.actingSubject }, headers('work')));
  if (work.error) return { outcome: commandOf(work.error), structure };
  if (!work.data || 'operationId' in work.data) return { outcome: 'pending', structure };
  const chapter = work.data.work;
  const placed = await settled(() => main.v1.compositions({ id: idOf(structure) }).changes.post({
    profile: 'book-composition', expectedHead: composition.head, actingSubject: input.actingSubject,
    operations: [{ op: 'insert', parent: structure, position: 'last', role: 'chapter', target: chapter,
      label: { value: input.title, language: input.language } }] }, headers(`insert:${idOf(composition.head)}`)));
  if (placed.error) return { outcome: commandOf(placed.error), chapter, structure };
  if (!placed.data || 'operationId' in placed.data || !placed.data.revision) return { outcome: 'pending', chapter, structure };
  return { outcome: 'done', head: placed.data.revision, chapter, structure, occurrence: placed.data.occurrences?.[0] };
}

/** Moves one chapter to the top of the Book or after another chapter. */
export async function moveChapter(input: { actingSubject: string; structure: string; head: string; occurrence: string;
  after: string | null; key: string }, main: MainClient = browserMainApi()): Promise<ChapterCommand> {
  const moved = await settled(() => main.v1.compositions({ id: idOf(input.structure) }).changes.post({
    profile: 'book-composition', expectedHead: input.head, actingSubject: input.actingSubject,
    operations: [{ op: 'move', occurrence: input.occurrence, parent: input.structure,
      position: input.after ? { after: input.after } : 'first' }] }, { headers: { 'idempotency-key': input.key } }));
  if (moved.error) return { outcome: commandOf(moved.error) };
  if (!moved.data || 'operationId' in moved.data || !moved.data.revision) return { outcome: 'pending' };
  return { outcome: 'done', head: moved.data.revision };
}
