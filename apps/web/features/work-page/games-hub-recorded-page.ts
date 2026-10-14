import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
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

/**
 * Where Read leads, with the caller's client. A selected language is the one text;
 * the caller resolves an unselected language (the server reads versions, a story does not invent that read).
 */
export async function readSuppliedStart(client: Host, id: string, work: string, textLanguage: () => Promise<string | null>) {
  const { main, actingSubject } = client;
  if (actingSubject) {
    const next = await settle(() => main.v1.me.continue.get({ query: { actingSubject, limit: 6 } }));
    const item = next.ok ? next.data.items.find(entry => entry.work === work) : undefined;
    if (item) {
      return { kind: item.lastPosition ? 'continue' as const : 'start' as const,
        href: item.nextUnread.href, chapter: item.nextUnread.title };
    }
  }
  const nothing = async () => await textLanguage() ? { kind: 'start' as const, href: textHref(id), chapter: null } : null;
  let parent: string | undefined;
  for (let depth = 0; depth < 3; depth += 1) {
    const level = await readSuppliedContents(client, id, { parent });
    if (!level.ok) return depth === 0 && level.failure === 'missing' ? nothing() : { kind: 'contents' as const };
    const first = level.data.items.find(item => item.availability === 'available');
    const occurrence = first ? idOf(first.occurrence) : null;
    if (!first || !occurrence) return depth === 0 && !level.data.items.length ? nothing() : { kind: 'contents' as const };
    if (first.role === 'chapter') return { kind: 'start' as const, href: chapterHref(id, occurrence),
      chapter: first.label?.value ?? null };
    parent = occurrence;
  }
  return { kind: 'contents' as const };
}

const absent = (read: { ok: true; data: { items?: readonly unknown[]; parts?: readonly unknown[] } } | { ok: false; failure: string }) =>
  read.ok ? !(read.data.items ?? read.data.parts)?.length
    : read.failure === 'missing' || read.failure === 'sign-in' || read.failure === 'identity';

/**
 * The samples a Games hub story replays. Labels follow this row: the member's chooser,
 * continue and progress keep their earlier names and the same production queries.
 * A projection page is recorded for the member; other personas' page read fails closed,
 * and the header types still take the non-book availability branch.
 */
export function recordedGamesSelections(persona: AnswerPersona, mode: 'populated' | 'saved' | 'loading'): RecordedSelection[] {
  if (mode === 'loading') return [{ label: 'work-header', state: 'loading' }];
  const member = persona === 'member';
  const selections: RecordedSelection[] = [
    { label: 'work-header', state: 'populated' },
    { label: 'hub-releases', state: 'populated' },
    { label: member ? 'realizations-empty' : 'hub-realizations-empty', state: 'populated' },
    { label: 'hub-partless-parts', state: 'error' },
    { label: member ? 'contents-unavailable' : 'hub-contents-unavailable', state: 'error' },
  ];
  if (member) selections.push({ label: 'hub-projection', state: 'populated' });
  if (persona === 'visitor') return selections;
  selections.push(
    { label: member ? 'continue-reading' : 'hub-continue-reading', state: 'populated' },
    { label: mode === 'saved' ? 'preference-saved' : 'preference-empty', state: mode === 'saved' ? 'populated' : 'empty' },
    { label: 'release-details', state: 'populated' },
    { label: member ? 'progress-summary' : 'hub-progress-summary', state: 'populated' },
  );
  if (mode === 'populated') selections.push({ label: 'choose-edition', state: 'populated' });
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
