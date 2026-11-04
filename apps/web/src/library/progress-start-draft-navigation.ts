import { m } from '../paraglide/messages.js';
import { isLocale } from '../paraglide/runtime.js';
import type { AuthoringLocation } from '../threads/authoring-departure';
import {
  progressAddressId,
  progressAddressIssue,
  progressIndexAddress,
  type ProgressIndexAddress,
} from './progress-address';
import type { ProgressIndex, ProgressMode } from './progress-reads';

export type ProgressStartDraft = {
  subjectId: string;
  versionSubjectId: string;
  mode: ProgressMode | undefined;
  unit: string;
  total: string;
};

/** Private, one-navigation context. The cursor stays in router history state, never the detail URL. */
export type ProgressReturnContext = {
  indexHref: string;
  indexSearch: ProgressIndexAddress;
  locale: string;
  sessionId: string;
  subjectId: string;
  startedAt?: string;
  sourceReturnTo?: string;
};

export type ProgressIndexReturnSelection = {
  locale: string;
  sessionId: string;
  subjectId: string;
  startedAt?: string;
  sourceReturnTo?: string;
};

const privateOrigin = 'https://rezics.invalid';
const returnSearchKeys = new Set(['subjectId', 'state', 'mode', 'profileId', 'cursor']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safeSourceHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return;
  try {
    const url = new URL(value, privateOrigin);
    if (url.origin !== privateOrigin || url.hash) return;
    return url.pathname + url.search;
  } catch {
    return;
  }
}

function indexAddressFromHref(value: unknown, locale: string): ProgressIndexAddress | undefined {
  if (typeof value !== 'string' || value.length > 8192 || !isLocale(locale)) return;
  try {
    const url = new URL(value, privateOrigin);
    if (url.origin !== privateOrigin || url.hash || url.pathname !== `/${locale}/library/progress`) return;
    const search: Record<string, string> = {};
    for (const [key, entry] of url.searchParams) {
      if (!returnSearchKeys.has(key) || Object.hasOwn(search, key)) return;
      search[key] = entry;
    }
    const address = progressIndexAddress(search);
    if (progressAddressIssue(address)) return;
    return address;
  } catch {
    return;
  }
}

export function progressIndexHref(
  page: ProgressIndex,
  cursor: string | null | undefined,
  locale: string,
): string | undefined {
  if (!isLocale(locale)) return;
  const search = progressIndexAddress({
    ...(page.subjectId ? { subjectId: page.subjectId } : {}),
    ...(page.state ? { state: page.state } : {}),
    ...(page.mode ? { mode: page.mode } : {}),
    ...(page.profileId ? { profileId: page.profileId } : {}),
    ...(cursor ? { cursor } : {}),
  });
  if (progressAddressIssue(search)) return;
  const params = new URLSearchParams();
  for (const key of ['subjectId', 'state', 'mode', 'profileId', 'cursor'] as const) {
    const value = search[key];
    if (value !== undefined) params.set(key, value);
  }
  return `/${locale}/library/progress${params.size ? `?${params}` : ''}`;
}

export function progressReturnContextForPage(
  page: ProgressIndex,
  cursor: string | null | undefined,
  locale: string,
  sessionId: string,
  subjectId: string,
  sourceReturnTo?: string,
  startedAt?: string,
): ProgressReturnContext | undefined {
  if (!progressAddressId.test(sessionId) || !progressAddressId.test(subjectId)) return;
  const indexHref = progressIndexHref(page, cursor, locale);
  const indexSearch = indexAddressFromHref(indexHref, locale);
  if (!indexHref || !indexSearch) return;
  const source = safeSourceHref(sourceReturnTo);
  return {
    indexHref,
    indexSearch,
    locale,
    sessionId,
    subjectId,
    ...(startedAt ? { startedAt } : {}),
    ...(source ? { sourceReturnTo: source } : {}),
  };
}

/** Router history state carries private context without changing the canonical detail href. */
export function progressReturnLocationState(context: ProgressReturnContext) {
  const { indexSearch: _indexSearch, ...progressReturn } = context;
  return { progressReturn };
}

export function progressReturnContextFromLocationState(
  value: unknown,
  sessionId: string,
  locale: string,
): ProgressReturnContext | undefined {
  const raw = record(record(value)?.progressReturn);
  if (!raw || raw.locale !== locale || raw.sessionId !== sessionId || !progressAddressId.test(sessionId)) return;
  if (typeof raw.subjectId !== 'string' || !progressAddressId.test(raw.subjectId)) return;
  const indexSearch = indexAddressFromHref(raw.indexHref, locale);
  if (!indexSearch) return;
  const startedAt =
    typeof raw.startedAt === 'string' && raw.startedAt.length <= 64 && !Number.isNaN(Date.parse(raw.startedAt))
      ? raw.startedAt
      : undefined;
  const sourceReturnTo = safeSourceHref(raw.sourceReturnTo);
  return {
    indexHref: String(raw.indexHref),
    indexSearch,
    locale,
    sessionId,
    subjectId: raw.subjectId,
    ...(startedAt ? { startedAt } : {}),
    ...(sourceReturnTo ? { sourceReturnTo } : {}),
  };
}

export function progressIndexSelectionLocationState(context: ProgressReturnContext, startedAt: string) {
  return {
    progressReturnSelection: {
      locale: context.locale,
      sessionId: context.sessionId,
      subjectId: context.subjectId,
      startedAt,
      ...(context.sourceReturnTo ? { sourceReturnTo: context.sourceReturnTo } : {}),
    },
  };
}

export function progressIndexReturnSelectionFromLocationState(
  value: unknown,
  locale: string,
): ProgressIndexReturnSelection | undefined {
  const raw = record(record(value)?.progressReturnSelection);
  if (
    !raw ||
    raw.locale !== locale ||
    !isLocale(locale) ||
    typeof raw.sessionId !== 'string' ||
    !progressAddressId.test(raw.sessionId) ||
    typeof raw.subjectId !== 'string' ||
    !progressAddressId.test(raw.subjectId)
  )
    return;
  const startedAt =
    typeof raw.startedAt === 'string' && raw.startedAt.length <= 64 && !Number.isNaN(Date.parse(raw.startedAt))
      ? raw.startedAt
      : undefined;
  const sourceReturnTo = safeSourceHref(raw.sourceReturnTo);
  return {
    locale,
    sessionId: raw.sessionId,
    subjectId: raw.subjectId,
    ...(startedAt ? { startedAt } : {}),
    ...(sourceReturnTo ? { sourceReturnTo } : {}),
  };
}

export function progressStartDraftFromPage(page: ProgressIndex): ProgressStartDraft {
  const firstChoice = page.progressChoices?.[0];
  return {
    subjectId: page.selectedSubject?.id ?? '',
    versionSubjectId: '',
    mode: firstChoice?.mode,
    unit: firstChoice?.units[0]?.id ?? '',
    total: '',
  };
}

export function progressStartDraftChanged(initial: ProgressStartDraft, current: ProgressStartDraft): boolean {
  return (
    initial.subjectId !== current.subjectId ||
    initial.versionSubjectId !== current.versionSubjectId ||
    initial.mode !== current.mode ||
    initial.unit !== current.unit ||
    initial.total !== current.total
  );
}

export function progressStartDraftNavigationContext(location: AuthoringLocation): string {
  const search = Object.entries(location.search).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([location.pathname, search]);
}

export function progressStartDraftNavigationMessages() {
  const title = m.library_progress_start_draft_navigation_title();
  const unsaved = m.library_progress_start_draft_navigation_unsaved();
  const pending = m.library_progress_start_draft_navigation_pending();
  return {
    title,
    unsaved,
    pending,
    discardTitle: title,
    discardUnsaved: unsaved,
    discardPending: pending,
    discardAction: m.library_progress_start_draft_navigation_discard(),
  };
}
