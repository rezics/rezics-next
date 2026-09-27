import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApi, mainApiWithToken } from '../api/main.ts';
import { failureOf, idOf, iri, type Loaded, type MainClient, type MyText, type RealmChoice, type Submission,
  type TextDraft, type WorkHeader, type WorkMetadata } from './types.ts';

// Studio's server reads. Every read acts as the Studio Agent from the route,
// never silently as the session Agent, and returns a `Loaded` result so one
// region's failure leaves the others standing.

type Answer<T> = { data: T | null; error: { status: number } | null };

/** Main answers 409 when its graph moved during a read that started from scratch; ask once more. */
async function settle<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

// Main has no read of one Agent's texts per Work or of one text's draft head,
// so Studio scans the Agent's own text list. Five pages bound the scan; the
// handoff proposes the owner read that removes it.
const SCAN_PAGES = 5;

async function scan<T>(page: (cursor: string | undefined) => Promise<Loaded<{ items: T[]; nextCursor: string | null }>>,
  keep: (item: T) => boolean, stopAtFirst = false): Promise<Loaded<T[]>> {
  const found: T[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < SCAN_PAGES; index += 1) {
    const loaded = await page(cursor);
    if (!loaded.ok) return found.length ? { ok: true, data: found } : loaded;
    found.push(...loaded.data.items.filter(keep));
    if (stopAtFirst && found.length) break;
    if (!loaded.data.nextCursor) break;
    cursor = loaded.data.nextCursor;
  }
  return { ok: true, data: found };
}

const myTexts = (main: MainClient, actingSubject: string) => (cursor: string | undefined) =>
  settle(() => main.v1.me.contributions.get({ query: { actingSubject, limit: 20, ...(cursor ? { cursor } : {}) } }));

const mySubmissions = (main: MainClient, actingSubject: string) => (cursor: string | undefined) =>
  settle(() => main.v1.my.submissions.get({ query: { actingSubject, limit: 20, ...(cursor ? { cursor } : {}) } }));

/** Realm names for submission badges, read anonymously (Realm headers are public). At most 20 Realms. */
async function realmNames(realms: readonly string[], locale: UiLocale): Promise<Record<string, string>> {
  const anonymous = mainApiWithToken(undefined);
  const names = await Promise.all([...new Set(realms)].slice(0, 20).map(async realm => {
    const loaded = await settle(() => anonymous.v1.realms({ realm: idOf(realm) }).get({ query: { language: locale } }));
    return [realm, loaded.ok ? loaded.data.name.value : null] as const;
  }));
  return Object.fromEntries(names.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}

export interface StudioHome {
  texts: Loaded<{ items: MyText[]; nextCursor: string | null }>;
  submissions: Loaded<Submission[]>;
  realms: Record<string, string>;
}

/** The Studio Agent's texts (one page) and its open Realm submissions with Realm names. */
export async function readStudioHome(actingSubject: string, locale: UiLocale, cursor?: string): Promise<StudioHome> {
  const main = await mainApi();
  const [texts, submissions] = await Promise.all([myTexts(main, actingSubject)(cursor),
    scan(mySubmissions(main, actingSubject), () => true)]);
  const realms = submissions.ok ? await realmNames(submissions.data.map(item => item.realm), locale) : {};
  return { texts, submissions, realms };
}

export interface StudioWork {
  header: WorkHeader;
  metadata: Loaded<WorkMetadata>;
  texts: Loaded<MyText[]>;
  submissions: Loaded<Submission[]>;
  realms: Record<string, string>;
}

/** One Work as the Studio Agent sees it: header, editable details, its texts and submissions. */
export const readStudioWork = cache(async (actingSubject: string, id: string, locale: UiLocale):
  Promise<Loaded<StudioWork>> => {
  const main = await mainApi();
  const work = iri(id);
  const [header, metadata, texts, submissions] = await Promise.all([
    settle(() => main.v1.works({ id }).get({ query: { language: locale, actingSubject } })),
    settle(() => main.v1.works({ id }).metadata.get({ query: { actingSubject } })),
    scan(myTexts(main, actingSubject), item => item.work?.id === work),
    scan(mySubmissions(main, actingSubject), item => item.work === work),
  ]);
  if (!header.ok) return header;
  const realms = submissions.ok ? await realmNames(submissions.data.map(item => item.realm), locale) : {};
  return { ok: true, data: { header: header.data, metadata, texts, submissions, realms } };
});

export interface StudioText {
  /** The text's current draft head, when Main lets this Agent list its texts. */
  head: string | null;
  /** The exact revision the editor opened: the head, or the revision the address names. */
  draft: Loaded<TextDraft>;
  publication: MyText['publication'] | null;
}

/**
 * One text to edit. The draft head comes from the Agent's text list; when that
 * list is unavailable, the address's `revision` (kept current by the editor
 * after every save) names the revision to open. A newer save elsewhere then
 * surfaces as a conflict on the next save, never as silent loss.
 */
export async function readStudioText(actingSubject: string, contribution: string, revision: string | null):
  Promise<StudioText> {
  const main = await mainApi();
  const listed = await scan(myTexts(main, actingSubject), item => item.id === iri(contribution), true);
  const mine = listed.ok ? listed.data[0] ?? null : null;
  const head = mine?.revision ?? null;
  const exact = head ?? (revision ? iri(revision) : null);
  if (!exact) {
    return { head: null, publication: null,
      draft: { ok: false, failure: listed.ok ? 'missing' : 'unavailable' } };
  }
  const draft = await settle(() => main.v1.contributions({ contribution })
    .drafts({ revision: idOf(exact) }).get({ query: { actingSubject } }));
  return { head, draft, publication: mine?.publication ?? null };
}

/** Realms to offer in the publish dialog: the first page of the public directory. */
export async function readRealmChoices(locale: UiLocale): Promise<Loaded<RealmChoice[]>> {
  const loaded = await settle(() => mainApiWithToken(undefined).v1.realms.get({ query: { limit: 20, language: locale } }));
  return loaded.ok ? { ok: true, data: loaded.data.items } : loaded;
}

/** One Work's header as the Studio Agent reads it: the writing page needs its title and Main Version. */
export const readWorkHeader = cache(async (actingSubject: string, id: string, locale: UiLocale): Promise<Loaded<WorkHeader>> => {
  const main = await mainApi();
  return settle(() => main.v1.works({ id }).get({ query: { language: locale, actingSubject } }));
});
