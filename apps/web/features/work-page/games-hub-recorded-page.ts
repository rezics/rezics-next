import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { workExperience } from '../entity-page/experience.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { readResourcePage, readWorkParts, readWorkRealizations } from './anime-hub-recorded-page.ts';
import { booksEditionReads, settle } from './books-edition-page.read.ts';
import { nextAction } from './primary-action.tsx';
import { chapterHref, type ContentsQuery, idOf, iriOf, textHref } from './route.ts';

// Supplied-client reads for the Games hub. The server page passes the request-cached
// host client; a recorded story passes the replaying client. The requests are the
// production availability list, the chooser and the primary action.

type Host = { main: MainClient; actingSubject?: string };

/** One level of contents, as `readContents` asks Main for it. */
export function readSuppliedContents(client: Host, id: string, query: ContentsQuery) {
  const { main, actingSubject } = client;
  return settle(() => main.v1.works({ id }).contents.get({ query: { actingSubject,
    parent: query.parent ? iriOf(query.parent) : undefined, language: query.language, cursor: query.cursor } }),
  query.cursor);
}

/** A Book's own resume is independent of Home's eligibility, ranking and page size. */
export async function readSuppliedBookStart(client: Host, id: string, work: string, textLanguage: () => Promise<string | null>) {
  if (idOf(work) !== id) return { kind: 'contents' as const };
  const { main, actingSubject } = client;
  if (!actingSubject) return readSuppliedStart(client, id, work, textLanguage);
  const next = await settle(() => main.v1.me.continue({ work: id }).get({ query: { actingSubject } }));
  if (!next.ok || next.data.work !== work) return { kind: 'contents' as const };
  if (next.data.nextUnread) {
    return { kind: next.data.lastPosition ? 'continue' as const : 'start' as const,
      href: next.data.nextUnread.href, chapter: next.data.nextUnread.title };
  }
  // Saved progress without a readable successor does not authorize restarting at chapter one.
  if (next.data.lastPosition) return { kind: 'contents' as const };
  // Main found no chapter resume; the Work may still have its own standalone text.
  return await textLanguage() ? { kind: 'start' as const, href: textHref(id), chapter: null } : null;
}

/**
 * Where Read leads, with the caller's client. A selected language is the one text;
 * the caller resolves an unselected language (the server reads versions, a story does not invent that read).
 */
export async function readSuppliedStart(client: Host, id: string, work: string, textLanguage: () => Promise<string | null>) {
  const { main, actingSubject } = client;
  if (actingSubject) {
    const next = await settle(() => main.v1.me.continue.get({ query: { actingSubject, limit: 6 } }));
    const continuing = next.ok ? { entries: next.data.items, nextCursor: next.data.nextCursor } : null;
    const item = continuing?.entries.find(entry => entry.work === work);
    if (item) {
      return { kind: item.lastPosition ? 'continue' as const : 'start' as const,
        href: item.nextUnread.href, chapter: item.nextUnread.title };
    }
  }
  const nothing = async () => await textLanguage() ? { kind: 'start' as const, href: textHref(id), chapter: null } : null;
  let parent: string | undefined;
  for (let depth = 0; depth < 3; depth += 1) {
    const level = await readSuppliedContents(client, id, { parent });
    if (!level.ok) return depth === 0 && level.failure === 'missing' ? nothing()
      : { kind: 'unavailable' as const, ...level };
    const contents = { entries: level.data.items, nextCursor: level.data.nextCursor };
    const first = contents.entries.find(item => item.availability === 'available');
    const occurrence = first ? idOf(first.occurrence) : null;
    if (!first || !occurrence) return depth === 0 && !contents.entries.length && !contents.nextCursor
      ? nothing() : { kind: 'contents' as const };
    if (first.role === 'chapter') return { kind: 'start' as const, href: chapterHref(id, occurrence),
      chapter: first.label?.value ?? null };
    parent = occurrence;
  }
  return { kind: 'contents' as const };
}

const absent = (read: { ok: true; data: { items?: readonly unknown[]; parts?: readonly unknown[]; nextCursor?: string | null; next?: string | null } }
  | { ok: false; failure: string }) => {
  if (!read.ok) return false;
  const page = { entries: read.data.items, nextCursor: read.data.nextCursor };
  return !(page.entries ?? read.data.parts)?.length && !page.nextCursor && !read.data.next;
};

/** The one sample with this label. Two names are the same production read when this row kept an earlier label. */
export function gamesAnswerLabel(record: AnswerRecord, persona: AnswerPersona, labels: readonly string[]): string {
  const counts = labels.map(label => ({ label,
    count: record.personas[persona].filter(item => item.label === label).length }));
  const repeated = counts.find(item => item.count > 1);
  if (repeated) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${repeated.label}`);
  const found = counts.filter(item => item.count === 1);
  if (found.length !== 1) throw new Error(`Expected one Games sample for ${record.row}/${persona} among ${labels.join(', ')}`);
  return found[0]!.label;
}

/**
 * The samples a Games hub story replays. Each production read takes the one recorded
 * label for that request. Every persona has a projection, and a non-book projection
 * draws the availability list and the chooser.
 */
export function recordedGamesSelections(record: AnswerRecord, persona: AnswerPersona,
  mode: 'populated' | 'saved' | 'loading'): RecordedSelection[] {
  if (mode === 'loading') return [{ label: gamesAnswerLabel(record, persona, ['work-header']), state: 'loading' }];
  const label = (...names: string[]) => gamesAnswerLabel(record, persona, names);
  const selections: RecordedSelection[] = [
    { label: label('work-header'), state: 'populated' },
    { label: label('hub-projection'), state: 'populated' },
    { label: label('hub-releases'), state: 'populated' },
    { label: label('realizations-empty', 'hub-realizations-empty'), state: 'populated' },
    { label: label('hub-partless-parts'), state: 'error' },
    { label: label('contents-unavailable', 'hub-contents-unavailable'), state: 'error' },
  ];
  if (persona === 'visitor') return selections;
  selections.push(
    { label: label('continue-reading', 'hub-continue-reading'), state: 'populated' },
    { label: label(mode === 'saved' ? 'preference-saved' : 'preference-empty'), state: mode === 'saved' ? 'populated' : 'empty' },
    { label: label('release-details'), state: 'populated' },
    { label: label('progress-summary', 'hub-progress-summary'), state: 'populated' },
  );
  if (mode === 'populated') selections.push({ label: label('choose-edition'), state: 'populated' });
  return selections;
}

/** Availability, the chooser reads and the primary action, through the production readers. */
export async function readGamesHub(client: Host, id: string, locale: UiLocale) {
  const reads = booksEditionReads(client);
  const [header, projection] = await Promise.all([
    reads.readWorkHeader(id),
    readResourcePage(client.main, client.actingSubject, id),
  ]);
  if (!header.ok) return { header };
  const experience = workExperience(projection.ok ? projection.data : null, header.data.types);
  if (experience.kind === 'book') return { header, projection, experience, book: true as const };
  if (!header.data.selectedLanguage) {
    throw new Error('Games start would read text versions; this Work has no selected language');
  }
  const selected = header.data.selectedLanguage;
  const [realizations, releases, parts, start, preference] = await Promise.all([
    readWorkRealizations(client.main, client.actingSubject, id),
    reads.readReleases(id),
    readWorkParts(client.main, client.actingSubject, id, { limit: 1 }),
    readSuppliedStart(client, id, header.data.id, () => Promise.resolve(selected)),
    reads.readEditionPreference(id),
  ]);
  const progress = await reads.readProgressSummary(id, preference.ok && preference.data ? preference.data.language : locale);
  const action = nextAction({ start, progress, preference, releases: releases.ok ? releases.data.items.length : 0 });
  const shown = !(absent(realizations) && absent(releases) && absent(parts));
  return { header, projection, experience, book: false as const, realizations, releases, parts, start, preference, progress,
    action, shown };
}
