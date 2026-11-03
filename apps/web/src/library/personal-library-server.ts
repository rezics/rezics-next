import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { KernelClient } from '@rezics/client';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { sessionSubject, viewerCredential } from '../session/request';
import { nameSubjectTypes, readRelease, typeNames } from '../subject/definitions';
import { loadPersonalLibrary, presentLibraryStateLabels, type PersonalLibraryView } from './entries-read';
import { loadContinueState, type ContinueResult } from './continue-read';
import { loadLibraryNavigation, type LibraryNavigationRead } from './pins-read';
import { shelfSort, validateShelfSearch, type ShelfSearch, type ShelfSort } from './shelf-params';

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
