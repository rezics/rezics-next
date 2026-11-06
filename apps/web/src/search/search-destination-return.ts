/** Remember the executed Search page when a result opens, and restore it on return. */

export type SearchDestinationOwner = Readonly<{
  href: string;
  locale: string;
  reader: string | null;
  cursor?: string;
}>;

const STORAGE_KEY = 'rezics.search.destination-return';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function owner(value: unknown): SearchDestinationOwner | null {
  if (!record(value) || typeof value.href !== 'string' || !value.href || typeof value.locale !== 'string') return null;
  if (value.reader !== null && typeof value.reader !== 'string') return null;
  if (value.cursor !== undefined && typeof value.cursor !== 'string') return null;
  return {
    href: value.href,
    locale: value.locale,
    reader: value.reader,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  };
}

function store(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

export function rememberSearchDestination(visit: SearchDestinationOwner): SearchDestinationOwner {
  const retained = {
    href: visit.href,
    locale: visit.locale,
    reader: visit.reader,
    ...(visit.cursor === undefined ? {} : { cursor: visit.cursor }),
  };
  store()?.setItem(STORAGE_KEY, JSON.stringify(retained));
  return retained;
}

export function readSearchDestination(): SearchDestinationOwner | null {
  const raw = store()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return owner(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Reader or locale replacement retires the remembered destination and any late restore. */
export function restoreSearchDestination(current: SearchDestinationOwner): SearchDestinationOwner | null {
  const retained = readSearchDestination();
  if (!retained) return null;
  if (retained.locale !== current.locale || retained.reader !== current.reader) {
    retireSearchDestination();
    return null;
  }
  if (retained.href !== current.href && current.href.split('#')[0] !== retained.href.split('#')[0]) return null;
  return retained;
}

export function retireSearchDestination(): void {
  store()?.removeItem(STORAGE_KEY);
}
