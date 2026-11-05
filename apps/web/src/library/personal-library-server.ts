import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { KernelClient } from '@rezics/client';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { nameSubjectTypes, readRelease, typeNames } from '../subject/definitions';
import { loadPersonalLibrary, presentLibraryStateLabels, type PersonalLibraryView } from './entries-read';
import { loadContinueState, type ContinueResult } from './continue-read';
import { loadLibraryNavigation, type LibraryNavigationRead } from './pins-read';
import { shelfAddressIssues, shelfSort, validateShelfSearch, type ShelfSearch, type ShelfSort } from './shelf-params';

export type PersonalLibraryAddress = ShelfSort & {
  type: string | null;
  state: string | null;
  cursor: string | null;
  locale: string;
};
export function personalLibraryAddress(input: ShelfSearch, locale: string): PersonalLibraryAddress {
  const search = validateShelfSearch(input as Record<string, unknown>);
  return {
    type: search.type ?? null,
    state: search.state ?? null,
    cursor: search.cursor ?? null,
    ...shelfSort(search),
    locale,
  };
}
export function samePersonalLibraryAddress(a: PersonalLibraryAddress, b: PersonalLibraryAddress): boolean {
  return (
    a.type === b.type &&
    a.state === b.state &&
    a.cursor === b.cursor &&
    a.orderBy === b.orderBy &&
    a.direction === b.direction &&
    a.locale === b.locale
  );
}
export type PersonalLibraryCurrentRead = {
  sessionSubject: string | null;
  requested: PersonalLibraryAddress;
  page: PersonalLibraryView;
  continueEntries: ContinueResult;
  navigation: LibraryNavigationRead;
};
export type PersonalContinueRead = {
  sessionSubject: string | null;
  requested: PersonalLibraryAddress;
  result: ContinueResult;
};
export type ShelfTitlePreparationReceipt = NonNullable<
  Awaited<ReturnType<KernelClient['libraryShelfTitlePreparation']['post']>>['data']
>;
export type ShelfScorePreparationReceipt = NonNullable<
  Awaited<ReturnType<KernelClient['libraryShelfScorePreparation']['post']>>['data']
>;
export async function prepareShelfTitleStep(
  client: KernelClient,
  authorization: string,
  key: string,
): Promise<ShelfTitlePreparationReceipt> {
  const response = await client.libraryShelfTitlePreparation.post(undefined, {
    headers: { authorization, 'idempotency-key': key },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (response.error || !response.data) throw new Error('Library title preparation failed');
  return response.data;
}
export async function prepareShelfScoreStep(
  client: KernelClient,
  authorization: string,
  key: string,
): Promise<ShelfScorePreparationReceipt> {
  const response = await client.libraryShelfScorePreparation.post(undefined, {
    headers: { authorization, 'idempotency-key': key },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (response.error || !response.data) throw new Error('Library score preparation failed');
  return response.data;
}

function validateInput(input: unknown): ShelfSearch {
  return validateShelfSearch(
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
  );
}
function prepared(request: Request) {
  const subject = sessionSubject(request);
  const credential = viewerCredential(request);
  return subject && credential ? { subject, credential } : undefined;
}

function validatePreparationKey(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error(`Invalid ${label} key`);
  return value;
}

function validateTitlePreparationInput(input: unknown): { search: ShelfSearch; key: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid title preparation');
  const value = input as Record<string, unknown>;
  const rawSearch = value.search;
  if (!rawSearch || typeof rawSearch !== 'object' || Array.isArray(rawSearch))
    throw new Error('Invalid title preparation address');
  const search = validateInput(rawSearch);
  if (shelfAddressIssues(rawSearch as Record<string, unknown>).length || search.orderBy !== 'title')
    throw new Error('Invalid title preparation address');
  return { search, key: validatePreparationKey(value.key, 'title preparation') };
}

function validateScorePreparationInput(input: unknown): { search: ShelfSearch; key: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid score preparation');
  const value = input as Record<string, unknown>;
  const rawSearch = value.search;
  if (!rawSearch || typeof rawSearch !== 'object' || Array.isArray(rawSearch))
    throw new Error('Invalid score preparation address');
  const search = validateInput(rawSearch);
  if (shelfAddressIssues(rawSearch as Record<string, unknown>).length || search.orderBy !== 'personalScore')
    throw new Error('Invalid score preparation address');
  return { search, key: validatePreparationKey(value.key, 'score preparation') };
}

/** Each native reader prepares its own request. No WeakMap entry or asserted viewer is shared between readers. */
export async function loadPersonalLibraryCurrent(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfSearch,
): Promise<PersonalLibraryCurrentRead> {
  const requested = personalLibraryAddress(input, requestLocale(request) ?? 'en');
  const requests = [request.clone(), request.clone(), request.clone()] as [Request, Request, Request];
  const [shelfRequest, continueRequest, navigationRequest] = requests;
  const [page, continueEntries, navigation] = await Promise.all([
    loadPersonalLibrary(client, shelfRequest, sessionEnv, validateInput(input)),
    loadContinueState(client, continueRequest, sessionEnv),
    loadLibraryNavigation(client, navigationRequest, sessionEnv, 8),
  ]);
  const origins = requests.map(prepared);
  const origin = origins[0];
  if (
    !origin ||
    !origins.every((value) => value?.subject === origin.subject && value.credential === origin.credential)
  ) {
    return {
      sessionSubject: null,
      requested,
      page: page.signedIn ? { ...page, entries: [], next: null, readState: page.readState ?? 'unavailable' } : page,
      continueEntries: continueEntries.state === 'loaded' ? { state: 'unavailable' } : continueEntries,
      navigation: {
        pins: navigation.pins.state === 'loaded' ? { state: 'unavailable' } : navigation.pins,
        collections: [],
        collectionsState: 'unavailable',
      },
    };
  }
  return { sessionSubject: origin.subject, requested, page, continueEntries, navigation };
}

async function namePage(view: PersonalLibraryView, locale: string): Promise<PersonalLibraryView> {
  if (!view.signedIn) return view;
  if (view.type) {
    const label = (await typeNames([view.type], locale)).get(view.type);
    if (label) view = { ...view, typeLabel: label };
  }
  if (view.readState) return view;
  await nameSubjectTypes(view.entries.map((entry) => entry.subject));
  return presentLibraryStateLabels(view, await readRelease().catch(() => undefined), locale);
}

export const readPersonalLibraryCurrent = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<PersonalLibraryCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadPersonalLibraryCurrent(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    return result.sessionSubject ? { ...result, page: await namePage(result.page, result.requested.locale) } : result;
  });

/** One explicit native title-preparation command, bound to its current address and viewer. */
export const preparePersonalLibraryTitle = createServerFn({ method: 'POST' })
  .validator(validateTitlePreparationInput)
  .handler(async ({ data }) => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale(request) ?? 'en';
    const requested = personalLibraryAddress(data.search, locale);
    if (await prepareSession(request, env as Partial<SessionEnv>)) throw new Error('Library session unavailable');
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    if (!authorization || !subject) throw new Error('Library session unavailable');
    const preparation = await prepareShelfTitleStep(kernelClient(locale), authorization, data.key);
    const current = sessionSubject(request) === subject && viewerCredential(request) === authorization;
    return { sessionSubject: current ? subject : null, requested, preparation };
  });

/** One explicit native score-preparation command, bound to its current address and viewer. */
export const preparePersonalLibraryScore = createServerFn({ method: 'POST' })
  .validator(validateScorePreparationInput)
  .handler(async ({ data }) => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale(request) ?? 'en';
    const requested = personalLibraryAddress(data.search, locale);
    if (await prepareSession(request, env as Partial<SessionEnv>)) throw new Error('Library session unavailable');
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    if (!authorization || !subject) throw new Error('Library session unavailable');
    const preparation = await prepareShelfScoreStep(kernelClient(locale), authorization, data.key);
    const current = sessionSubject(request) === subject && viewerCredential(request) === authorization;
    return { sessionSubject: current ? subject : null, requested, preparation };
  });

/** Refresh only the existing bounded Continue source, with that reader's actual preparation. */
export const readPersonalLibraryContinue = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<PersonalContinueRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest().clone() as Request;
    const requested = personalLibraryAddress(data, requestLocale(request) ?? 'en');
    const result = await loadContinueState(kernelClient(), request, env as Partial<SessionEnv>);
    const origin = prepared(request);
    return {
      sessionSubject: origin?.subject ?? null,
      requested,
      result: !origin && result.state === 'loaded' ? { state: 'unavailable' } : result,
    };
  });
