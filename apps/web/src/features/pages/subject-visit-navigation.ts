import { releaseVisitReturn } from '../catalogue/release-fidelity/navigation';
import { creditReturn } from '../catalogue/credit-inspection/navigation';
import { realmReadingReturn } from '../../community/realm-reading-return';
import {
  workFranchiseReturn,
  workFranchiseFragment,
  type WorkFranchiseReturn,
} from '../catalogue/work-franchise-reading/navigation';
import { subjectHref } from '../../subject/subject-href';
import { realmCatalogueReturnHref } from '../../search/realm-catalogue-handoff';
import { isView } from '@rezics/composition';
import { copiesSubjectId } from '../../library/copies-query';
import { mangaOccurrenceFromFragment } from '../catalogue/manga-reader/navigation';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const subjectDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/subjects/${uuid}/[^/?#]+(?:/([^/?#]+))?$`);
const musicContextDestination = new RegExp(
  `^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/subjects/${uuid}/[^/?#]+/music-context$`,
);
const realmDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/realms/${uuid}$`);
const copiesDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/library/copies$`);
const importDestination = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\/library\/import-vndb$/;
const returnAddressCap = 32768;
const literaryHistoryLimit = 8;
const collectionDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/collections/${uuid}$`);
const subjectCommunityFragment = /^#subject-community-[A-Za-z0-9_-]{1,64}$/u;

function validLiteraryHistory(value: string): boolean {
  if (value.length > returnAddressCap) return false;
  try {
    const history: unknown = JSON.parse(value);
    return (
      Array.isArray(history) &&
      history.length <= literaryHistoryLimit &&
      history.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const item = entry as Record<string, unknown>;
        return (
          Object.keys(item).every((key) => ['view', 'node', 'cursor', 'focus'].includes(key)) &&
          (item.view === 'overview' || item.view === 'contents' || item.view === 'editions') &&
          (item.node === undefined || (typeof item.node === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(item.node))) &&
          (item.cursor === undefined ||
            (item.node !== undefined &&
              typeof item.cursor === 'string' &&
              item.cursor.length > 0 &&
              item.cursor.length <= 8192 &&
              !/[\u0000-\u001f\u007f]/u.test(item.cursor))) &&
          (item.view !== 'overview' || (item.node === undefined && item.cursor === undefined)) &&
          (item.focus === undefined ||
            (typeof item.focus === 'string' && /^[A-Za-z0-9:._~-]{1,256}$/u.test(item.focus)))
        );
      })
    );
  } catch {
    return false;
  }
}

export type WorkTagReturn = {
  statement: string;
  property: string;
  spoiler: 0 | 1 | 2;
  focus: 'browse' | 'evidence';
};

export type OrganizationHistoryVisitReturn = {
  holder: string;
  context: string;
  locale: string;
  realm?: string;
  property: string;
  candidate: string;
  revision: number;
  release: string;
  focus: 'keyboard' | 'pointer';
};

/** A current Organization assertion locator; it carries no retained reading or disclosure authority. */
export function organizationHistoryVisitReturn(fragment: string): OrganizationHistoryVisitReturn | undefined {
  if (!fragment.startsWith('#organization-history?') || fragment.length > 2048) return;
  const params = new URLSearchParams(fragment.slice('#organization-history?'.length));
  const keys = [...params.keys()];
  if (
    (keys.length !== 8 && keys.length !== 9) ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) =>
        !['holder', 'context', 'locale', 'realm', 'property', 'candidate', 'revision', 'release', 'focus'].includes(
          key,
        ),
    )
  )
    return;
  const holder = params.get('holder');
  const context = params.get('context');
  const locale = params.get('locale');
  const realm = params.get('realm');
  const property = params.get('property');
  const candidate = params.get('candidate');
  const revision = params.get('revision');
  const release = params.get('release');
  const focus = params.get('focus');
  if (
    !holder ||
    !new RegExp(`^${uuid}$`, 'i').test(holder) ||
    !context ||
    !new RegExp(`^${uuid}$`, 'i').test(context) ||
    !locale ||
    !/^(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)$/u.test(locale) ||
    (realm !== null && !new RegExp(`^${uuid}$`, 'i').test(realm)) ||
    !property ||
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(property) ||
    !candidate ||
    !new RegExp(`^${uuid}$`, 'i').test(candidate) ||
    !revision ||
    !/^[1-9][0-9]{0,8}$/u.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    !release ||
    !/^[A-Za-z0-9:_./-]{1,128}$/u.test(release) ||
    (focus !== 'keyboard' && focus !== 'pointer')
  )
    return;
  return {
    holder,
    context,
    locale,
    ...(realm ? { realm } : {}),
    property,
    candidate,
    revision: Number(revision),
    release,
    focus,
  };
}

export function organizationHistoryVisitReturnFragment(value: OrganizationHistoryVisitReturn): string {
  const fragment = `#organization-history?${new URLSearchParams({
    holder: value.holder,
    context: value.context,
    locale: value.locale,
    ...(value.realm ? { realm: value.realm } : {}),
    property: value.property,
    candidate: value.candidate,
    revision: String(value.revision),
    release: value.release,
    focus: value.focus,
  })}`;
  return organizationHistoryVisitReturn(fragment) ? fragment : '#connections';
}

/** A focus locator for one admitted assertion, never a label, weight, grant or disclosure override. */
export function workTagReturn(hash: string): WorkTagReturn | undefined {
  if (!hash.startsWith('#work-tags?') || hash.length > 1024) return;
  const params = new URLSearchParams(hash.slice('#work-tags?'.length));
  const keys = [...params.keys()];
  if (
    keys.length !== 4 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['statement', 'property', 'spoiler', 'focus'].includes(key))
  )
    return;
  const statement = params.get('statement');
  const property = params.get('property');
  const spoiler = params.get('spoiler');
  const focus = params.get('focus');
  if (
    !statement ||
    !new RegExp(`^${uuid}$`, 'i').test(statement) ||
    !property ||
    property.length > 128 ||
    /[\s\u0000-\u001f\u007f]/u.test(property) ||
    (spoiler !== '0' && spoiler !== '1' && spoiler !== '2') ||
    (focus !== 'browse' && focus !== 'evidence')
  )
    return;
  return { statement, property, spoiler: Number(spoiler) as 0 | 1 | 2, focus };
}

export function workTagReturnFragment(value: WorkTagReturn): string {
  const hash = `#work-tags?${new URLSearchParams({ ...value, spoiler: String(value.spoiler) })}`;
  return workTagReturn(hash) ? hash : '#work-tags';
}

/** Preserve the supported source address, including its opaque native window, in the existing visit facility. */
export function workTagReturnHref(
  currentHref: string | undefined,
  fallbackHref: string,
  locale: string,
  selection?: WorkTagReturn,
): string {
  const fallback = subjectVisitReturn(`${fallbackHref.split('#')[0]}#work-tags`, locale);
  if (!fallback) return fallbackHref;
  const accepted = subjectVisitReturn(currentHref, locale);
  const base = new URL(fallback, 'https://rezics.invalid');
  const source = accepted ? new URL(accepted, base) : base;
  const expectedSubject = base.pathname.split('/')[3];
  const actualSubject = source.pathname.split('/')[3];
  const path = subjectDestination.exec(source.pathname);
  if (!path || actualSubject !== expectedSubject) return fallback;
  source.hash = selection ? workTagReturnFragment(selection) : '#work-tags';
  return subjectVisitReturn(`${source.pathname}${source.search}${source.hash}`, locale) ?? fallback;
}

/** Preserve the actual supported work region through the same validators used by destination routes. */
export function workFranchiseReturnHref(
  currentHref: string | undefined,
  fallbackHref: string,
  locale: string,
  selection?: WorkFranchiseReturn,
): string {
  const fallback = subjectVisitReturn(`${fallbackHref.split('#')[0]}#work-franchise`, locale);
  if (!fallback) return fallbackHref;
  const base = new URL(fallback, 'https://rezics.invalid');
  const accepted = subjectVisitReturn(currentHref, locale);
  const source = accepted ? new URL(accepted, base) : base;
  if (!subjectDestination.test(source.pathname) || source.pathname.split('/')[3] !== base.pathname.split('/')[3])
    return fallback;
  source.hash = selection ? workFranchiseFragment(selection) : '#work-franchise';
  return subjectVisitReturn(`${source.pathname}${source.search}${source.hash}`, locale) ?? fallback;
}

/** Restart the selected current reader without transplanting the retired native continuation. */
export function workFranchiseRestartHref(href: string, locale: string): string {
  const accepted = subjectVisitReturn(href, locale);
  if (!accepted) return href;
  const url = new URL(accepted, 'https://rezics.invalid');
  url.searchParams.delete('cursor');
  url.hash = '#work-franchise';
  return subjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, locale) ?? href;
}

/** Concept work-tag journeys share Subject visit validation; graph-only origins keep their separate contract. */
export function workTagOriginatingReturn(value: unknown, locale?: string): string | undefined {
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  if (!subjectDestination.test(url.pathname)) return;
  if (url.hash !== '#work-tags' && !workTagReturn(url.hash)) return;
  return accepted;
}

export type ConnectionReturnWindow = {
  stream: string;
  cursor?: string;
  reading?: string;
  focus?: string;
  holder?: string;
  control?: 'browse' | 'evidence';
  history?: { cursor?: string; reading: string; page: number }[];
  index?: number;
};

export type WorkCastVisitReturn = {
  context: string;
  node: string;
  presentation: 'character' | 'credit-order';
  statement?: string;
  character?: string;
  /** Bounded opaque page addresses before the selected page; payloads are always re-read. */
  history?: (string | null)[];
};

/** A work-cast return selects one current row and a bounded stream address, never its old payload. */
export function workCastVisitReturn(fragment: string): WorkCastVisitReturn | undefined {
  if (!fragment.startsWith('#work-cast?') || fragment.length > 32768) return;
  const params = new URLSearchParams(fragment.slice('#work-cast?'.length));
  const keys = [...params.keys()];
  if (
    keys.length < 3 ||
    keys.length > 6 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['context', 'node', 'presentation', 'statement', 'character', 'history'].includes(key))
  )
    return;
  const context = params.get('context');
  const node = params.get('node');
  const presentation = params.get('presentation');
  const statement = params.get('statement');
  const character = params.get('character');
  const serializedHistory = params.get('history');
  let history: (string | null)[] | undefined;
  if (serializedHistory !== null) {
    if (serializedHistory.length > 16000) return;
    try {
      const parsed: unknown = JSON.parse(serializedHistory);
      if (
        !Array.isArray(parsed) ||
        parsed.length > 16 ||
        parsed.some(
          (cursor) =>
            cursor !== null &&
            (typeof cursor !== 'string' || cursor.length > 4096 || /[\u0000-\u001f\u007f]/u.test(cursor)),
        )
      )
        return;
      history = parsed as (string | null)[];
    } catch {
      return;
    }
  }
  if (
    !context ||
    !new RegExp(`^${uuid}$`, 'i').test(context) ||
    !node ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(node) ||
    (presentation !== 'character' && presentation !== 'credit-order') ||
    (statement !== null && !new RegExp(`^${uuid}$`, 'i').test(statement)) ||
    (character !== null && !new RegExp(`^${uuid}$`, 'i').test(character)) ||
    (character !== null && statement === null)
  )
    return;
  return {
    context,
    node,
    presentation,
    ...(statement ? { statement } : {}),
    ...(character ? { character } : {}),
    ...(history !== undefined ? { history } : {}),
  };
}

export function workCastVisitReturnFragment(value: WorkCastVisitReturn, maxEncodedHistory = 16000): string {
  const history = value.history ? [...value.history].slice(-16) : undefined;
  const historyBudget = Math.max(0, Math.min(16000, Math.floor(maxEncodedHistory)));
  while (history && history.length && encodeURIComponent(JSON.stringify(history)).length > historyBudget)
    history.shift();
  const retainedHistory =
    history && encodeURIComponent(JSON.stringify(history)).length <= historyBudget ? history : undefined;
  const params = new URLSearchParams({
    context: value.context,
    node: value.node,
    presentation: value.presentation,
    ...(value.statement ? { statement: value.statement } : {}),
    ...(value.character ? { character: value.character } : {}),
    ...(retainedHistory !== undefined ? { history: JSON.stringify(retainedHistory) } : {}),
  });
  const fragment = `#work-cast?${params}`;
  return workCastVisitReturn(fragment) ? fragment : '#work-cast';
}

/** The released Character streams keep their existing native section owner on return. */
export function connectionReturnGroup(window: ConnectionReturnWindow): 'relations' | 'characters' | 'credits' {
  if (window.stream === 'in:schema:character') return 'characters';
  if (window.stream === 'in:wdt:P725:qualified') return 'credits';
  return 'relations';
}

export type SummaryReadingReturn = {
  candidateId: string;
  documentId: string;
  digest: string;
  language: string;
  locale: string;
  context?: string;
  realm?: string;
  release?: string;
  source?: string;
  expanded?: boolean;
  focus?: 'reading' | 'evidence';
};

const boundedToken = (value: string, max: number) =>
  value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/u.test(value);

/** A bounded locator for one public synopsis view; it contains no body, credentials, or editor state. */
export function summaryReadingReturn(hash: string): SummaryReadingReturn | undefined {
  if (!hash.startsWith('#subject-summary-reading?') || hash.length > 2048) return;
  const params = new URLSearchParams(hash.slice('#subject-summary-reading?'.length));
  const allowed = new Set([
    'candidate',
    'document',
    'digest',
    'language',
    'locale',
    'context',
    'realm',
    'release',
    'source',
    'expanded',
    'focus',
  ]);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !allowed.has(key))) return;
  const candidateId = params.get('candidate');
  const documentId = params.get('document');
  const digest = params.get('digest');
  const language = params.get('language');
  const locale = params.get('locale');
  const context = params.get('context');
  const realm = params.get('realm');
  const release = params.get('release');
  const source = params.get('source');
  const expanded = params.get('expanded');
  const focus = params.get('focus');
  if (
    !candidateId ||
    !boundedToken(candidateId, 128) ||
    !documentId ||
    !boundedToken(documentId, 128) ||
    !digest ||
    !boundedToken(digest, 128) ||
    !language ||
    !boundedToken(language, 35) ||
    !/^([A-Za-z]{2,8})(-[A-Za-z0-9]{1,8})*$/u.test(language) ||
    !locale ||
    !boundedToken(locale, 35) ||
    (context !== null && !boundedToken(context, 128)) ||
    (realm !== null && !boundedToken(realm, 128)) ||
    (release !== null && !boundedToken(release, 128)) ||
    (source !== null && !boundedToken(source, 128)) ||
    (expanded !== null && expanded !== '1') ||
    (focus !== null && focus !== 'reading' && focus !== 'evidence')
  )
    return;
  try {
    if (Intl.getCanonicalLocales(language).length !== 1) return;
    if (Intl.getCanonicalLocales(locale).length !== 1) return;
  } catch {
    return;
  }
  return {
    candidateId,
    documentId,
    digest,
    language,
    locale,
    ...(context ? { context } : {}),
    ...(realm ? { realm } : {}),
    ...(release ? { release } : {}),
    ...(source ? { source } : {}),
    ...(expanded === '1' ? { expanded: true } : {}),
    ...(focus ? { focus: focus as 'reading' | 'evidence' } : {}),
  };
}

export function summaryReadingFragment(value: SummaryReadingReturn): string | undefined {
  const params = new URLSearchParams({
    candidate: value.candidateId,
    document: value.documentId,
    digest: value.digest,
    language: value.language,
    locale: value.locale,
    ...(value.context ? { context: value.context } : {}),
    ...(value.realm ? { realm: value.realm } : {}),
    ...(value.release ? { release: value.release } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(value.expanded ? { expanded: '1' } : {}),
    ...(value.focus ? { focus: value.focus } : {}),
  });
  const fragment = `#subject-summary-reading?${params}`;
  return summaryReadingReturn(fragment) ? fragment : undefined;
}

/** An opaque public locator, not rows, credentials, a reveal grant or a recursive opener. */
export function connectionReturnWindow(hash: string): ConnectionReturnWindow | undefined {
  if (!hash.startsWith('#connections?') || hash.length > 28000) return;
  const params = new URLSearchParams(hash.slice('#connections?'.length));
  const keys = [...params.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['stream', 'cursor', 'reading', 'focus', 'holder', 'control', 'history', 'index'].includes(key))
  )
    return;
  const stream = params.get('stream');
  let reading = params.get('reading');
  let cursor = params.get('cursor');
  const focus = params.get('focus');
  const holder = params.get('holder');
  const control = params.get('control');
  const rawHistory = params.get('history');
  const rawIndex = params.get('index');
  let history: ConnectionReturnWindow['history'];
  let index: number | undefined;
  if (rawHistory !== null || rawIndex !== null) {
    if (rawHistory === null || rawIndex === null || !/^(0|[1-9]\d*)$/.test(rawIndex)) return;
    try {
      const entries: unknown = JSON.parse(rawHistory);
      index = Number(rawIndex);
      if (
        !Array.isArray(entries) ||
        entries.length < 1 ||
        entries.length > 8 ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= entries.length
      )
        return;
      history = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') return;
        const address = entry as Record<string, unknown>;
        if (
          Object.keys(address).some((key) => !['cursor', 'reading', 'page'].includes(key)) ||
          typeof address.reading !== 'string' ||
          !/^[a-f0-9]{64}$/.test(address.reading) ||
          !Number.isSafeInteger(address.page) ||
          Number(address.page) < 1 ||
          (address.cursor !== undefined &&
            (typeof address.cursor !== 'string' ||
              !address.cursor ||
              address.cursor.length > 8192 ||
              /[\u0000-\u001f\u007f]/u.test(address.cursor)))
        )
          return;
        history.push({
          ...(address.cursor ? { cursor: address.cursor } : {}),
          reading: address.reading,
          page: Number(address.page),
        });
      }
      if (history.some((entry, entryIndex) => entryIndex > 0 && entry.page !== history![entryIndex - 1]!.page + 1))
        return;
      const current = history[index]!;
      if ((reading !== null && reading !== current.reading) || (cursor !== null && cursor !== current.cursor)) return;
      reading = current.reading;
      cursor = current.cursor ?? null;
    } catch {
      return;
    }
  } else if (rawIndex !== null) return;
  if (
    !stream ||
    !/^(in|out):[^\s\u0000-\u001f\u007f]{1,256}$/u.test(stream) ||
    (reading !== null && !/^[a-f0-9]{64}$/.test(reading)) ||
    (reading === null && (cursor !== null || focus !== null || holder !== null)) ||
    (cursor !== null && (!cursor || cursor.length > 8192 || /[\u0000-\u001f\u007f]/u.test(cursor))) ||
    (focus !== null && !new RegExp(`^${uuid}$`).test(focus)) ||
    (holder !== null && (!focus || !new RegExp(`^${uuid}$`).test(holder))) ||
    (focus !== null && !holder) ||
    (control !== null && (!focus || (control !== 'browse' && control !== 'evidence')))
  )
    return;
  return {
    stream,
    ...(reading ? { reading } : {}),
    ...(cursor ? { cursor } : {}),
    ...(focus ? { focus, holder: holder! } : {}),
    ...(control ? { control: control as 'browse' | 'evidence' } : {}),
    ...(history && index !== undefined ? { history, index } : {}),
  };
}

export function connectionWindowFragment(window: ConnectionReturnWindow): string {
  const fragment = (history?: ConnectionReturnWindow['history'], index?: number) => {
    const params = new URLSearchParams({ stream: window.stream });
    if (history && index !== undefined) {
      params.set('history', JSON.stringify(history));
      params.set('index', String(index));
    } else {
      if (window.reading) params.set('reading', window.reading);
      if (window.cursor) params.set('cursor', window.cursor);
    }
    if (window.focus && window.holder) {
      params.set('focus', window.focus);
      params.set('holder', window.holder);
      if (window.control) params.set('control', window.control);
    }
    return `#connections?${params}`;
  };
  let history = window.history
    ?.filter((entry) => Number.isSafeInteger(entry.page) && entry.page > 0)
    .map((entry) => ({ ...entry }));
  let index = window.index;
  while (history && history.length && index !== undefined) {
    const hash = fragment(history, index);
    if (connectionReturnWindow(hash)) return hash;
    if (history.length <= 1) break;
    if (index < history.length - 1) history.pop();
    else {
      history.shift();
      index--;
    }
  }
  const hash = fragment();
  return connectionReturnWindow(hash) ? hash : '#connections';
}

function collectionReturn(url: URL, locale?: string): string | undefined {
  const match = collectionDestination.exec(url.pathname);
  if (!match || (locale !== undefined && match[1] !== locale)) return undefined;
  const params = new URLSearchParams();
  const seen = new Set<string>();
  let filters = 0;
  for (const [key, value] of url.searchParams) {
    if (key === 'cursor' || key === 'layout' || key === 'type') {
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (key === 'cursor' && value.length > 4096) return undefined;
      if (key === 'layout' && value !== 'grid' && value !== 'list') return undefined;
      if (key === 'type' && value.length > 128) return undefined;
      params.append(key, value);
    } else if (/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) && value.length <= 256 && filters < 100) {
      params.append(key, value);
      filters += 1;
    }
  }
  const hash = /^#collection-member-[0-9a-f-]{36}$/i.test(url.hash) ? url.hash : '';
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ''}${hash}`;
}

/** A public return address may restore one admitted Subject or Collection view window. */
/** Keep one existing nested Subject return intent, but never grow an unbounded URL history. */
function subjectVisitReturnAt(value: unknown, locale: string | undefined, nested: boolean): string | undefined {
  if (typeof value !== 'string' || value.length > returnAddressCap) return;
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return;
  const realmReading = realmReadingReturn(value, locale);
  if (realmReading) return realmReading;
  const catalogueReturn = realmCatalogueReturnHref(value, locale);
  if (catalogueReturn) return catalogueReturn;
  if (!value.startsWith('/') || value.startsWith('//')) return;
  const rawPath = value.split(/[?#]/u, 1)[0] ?? '';
  if (/%(?:2f|5c)/iu.test(rawPath)) return;
  try {
    const decodedPath = decodeURIComponent(rawPath);
    if (
      decodedPath.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(decodedPath) ||
      decodedPath.split('/').some((segment) => segment === '.' || segment === '..') ||
      /%(?:25|2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(decodedPath)
    )
      return;
    const url = new URL(value, 'https://rezics.invalid');
    const importPath = importDestination.exec(url.pathname);
    if (importPath) {
      // A public work may return to the import landmark, never its private page, upload, reader or credential.
      if (
        url.origin !== 'https://rezics.invalid' ||
        (locale !== undefined && importPath[1] !== locale) ||
        url.search ||
        url.hash !== '#vndb-current-library'
      )
        return;
      return `${url.pathname}${url.hash}`;
    }
    const collection = collectionReturn(url, locale);
    if (collection) return collection;
    const quotation = subjectDestination.exec(url.pathname);
    if (quotation?.[2] === 'quotations') {
      const keys = [...url.searchParams.keys()];
      const quote = url.searchParams.get('quote');
      const marker = url.searchParams.get('quotationReturn');
      const origin = url.searchParams.get('returnTo');
      if (
        url.origin !== 'https://rezics.invalid' ||
        (locale !== undefined && quotation[1] !== locale) ||
        url.hash ||
        new Set(keys).size !== keys.length ||
        keys.some((key) => !['quote', 'quotationReturn', 'returnTo'].includes(key)) ||
        (quote !== null && !new RegExp(`^${uuid}$`, 'i').test(quote)) ||
        (marker !== null && !boundedToken(marker, 128)) ||
        (origin !== null &&
          (origin.length > 2048 ||
            !origin.startsWith('/') ||
            origin.startsWith('//') ||
            origin.includes('\\') ||
            /[\u0000-\u001f\u007f]/u.test(origin)))
      )
        return;
      return `${url.pathname}${url.search}`;
    }
    const musicContext = musicContextDestination.exec(url.pathname);
    if (musicContext) {
      const keys = [...url.searchParams.keys()];
      const stream = url.searchParams.get('stream');
      const cursor = url.searchParams.get('cursor');
      if (
        url.origin !== 'https://rezics.invalid' ||
        (locale !== undefined && musicContext[1] !== locale) ||
        url.hash ||
        new Set(keys).size !== keys.length ||
        keys.some((key) => key !== 'stream' && key !== 'cursor') ||
        (stream !== null && !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]{1,128}$/u.test(stream)) ||
        (cursor !== null && (!stream || !cursor || cursor.length > 8192 || /[\u0000-\u001f\u007f]/u.test(cursor)))
      )
        return;
      return `${url.pathname}${url.search}`;
    }
    const subject = subjectDestination.exec(url.pathname);
    const realmPath = realmDestination.exec(url.pathname);
    const copiesPath = copiesDestination.exec(url.pathname);
    const match = subject ?? realmPath ?? copiesPath;
    if (
      url.origin !== 'https://rezics.invalid' ||
      !match ||
      (locale !== undefined && match[1] !== locale) ||
      (subject?.[2] !== undefined && !isView(subject[2]) && subject[2] !== 'sources')
    )
      return;
    if (copiesPath) {
      const keys = [...url.searchParams.keys()];
      if (
        url.hash ||
        new Set(keys).size !== keys.length ||
        keys.some((key) => key !== 'subjectId' && key !== 'cursor') ||
        (url.searchParams.has('subjectId') && !copiesSubjectId(url.searchParams.get('subjectId'))) ||
        (url.searchParams.get('cursor')?.length ?? 0) > 2048
      )
        return;
      return `${url.pathname}${url.search}`;
    }
    const allowed = new Set([
      'realm',
      'context',
      'node',
      'cursor',
      'history',
      'focus',
      'property',
      'screenCursor',
      'screenSelection',
      'musicReturnStream',
      'musicReturnCursor',
      'musicReturnRevision',
      'musicReturnDigest',
      'musicReturnHolder',
      'musicReturnStatement',
    ]);
    const keys = [...url.searchParams.keys()];
    const nestedVia = url.searchParams.getAll('via');
    if (nestedVia.length) {
      if (!subject || nested || nestedVia.length !== 1 || !subjectVisitReturnAt(nestedVia[0], locale, true)) return;
      allowed.add('via');
    }
    if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return;
    const selectedRealm = url.searchParams.get('realm');
    const selectedContext = url.searchParams.get('context');
    const node = url.searchParams.get('node');
    const cursor = url.searchParams.get('cursor');
    const history = url.searchParams.get('history');
    const focus = url.searchParams.get('focus');
    const property = url.searchParams.get('property');
    const screenCursor = url.searchParams.get('screenCursor');
    const screenSelection = url.searchParams.get('screenSelection');
    const musicStream = url.searchParams.get('musicReturnStream');
    const musicCursor = url.searchParams.get('musicReturnCursor');
    const musicRevision = url.searchParams.get('musicReturnRevision');
    const musicDigest = url.searchParams.get('musicReturnDigest');
    const musicHolder = url.searchParams.get('musicReturnHolder');
    const musicStatement = url.searchParams.get('musicReturnStatement');
    const musicReturn = [musicStream, musicCursor, musicRevision, musicDigest, musicHolder, musicStatement].some(
      (part) => part !== null,
    );
    const screenEntry = /^#screen-episode-entry-([0-9a-f-]{36})$/i.exec(url.hash);
    const recordingStatement = new RegExp(`^#recording-statement-${uuid}$`, 'i').test(url.hash);
    const screenReturn = screenCursor !== null || screenSelection !== null || screenEntry !== null;
    if (
      (selectedRealm !== null && !new RegExp(`^${uuid}$`).test(selectedRealm)) ||
      (selectedContext !== null && (!subject || !new RegExp(`^${uuid}$`, 'i').test(selectedContext))) ||
      (musicReturn &&
        (!subject ||
          (musicStream !== null && (!musicStream || musicStream.length > 256)) ||
          (musicStream !== null && /[\u0000-\u001f\u007f]/u.test(musicStream)) ||
          (musicCursor !== null &&
            (!musicStream ||
              !musicCursor ||
              musicCursor.length > 4096 ||
              /[\u0000-\u001f\u007f]/u.test(musicCursor))) ||
          !musicRevision ||
          !/^\d{1,16}$/u.test(musicRevision) ||
          !Number.isSafeInteger(Number(musicRevision)) ||
          !musicDigest ||
          !boundedToken(musicDigest, 128) ||
          (musicHolder === null) !== (musicStatement === null) ||
          (musicHolder !== null && !new RegExp(`^${uuid}$`, 'i').test(musicHolder)) ||
          (musicStatement !== null && !new RegExp(`^${uuid}$`, 'i').test(musicStatement)))) ||
      (node !== null && (!subject?.[2] || !/^[A-Za-z0-9_-]{1,64}$/.test(node))) ||
      (cursor !== null &&
        (!subject?.[2] || !cursor || cursor.length > 8192 || /[\u0000-\u001f\u007f]/u.test(cursor))) ||
      (property !== null &&
        (!subject?.[2] || !property.trim() || property.length > 256 || /[\u0000-\u001f\u007f]/u.test(property))) ||
      (history !== null && (url.hash !== '#literary-reader' || !validLiteraryHistory(history))) ||
      (focus !== null && (url.hash !== '#literary-reader' || !/^[A-Za-z0-9:._~-]{1,256}$/u.test(focus))) ||
      (screenReturn &&
        (subject?.[2] !== undefined ||
          (screenCursor !== null &&
            (!screenCursor || screenCursor.length > 8192 || /[\u0000-\u001f\u007f]/u.test(screenCursor))) ||
          (screenSelection !== null && !new RegExp(`^${uuid}$`, 'i').test(screenSelection)) ||
          (screenEntry !== null && !new RegExp(`^${uuid}$`, 'i').test(screenEntry[1]!)) ||
          (screenSelection !== null && screenEntry?.[1]?.toLowerCase() !== screenSelection.toLowerCase()) ||
          (screenSelection === null && screenEntry !== null)))
    )
      return;
    const fragment = url.hash === '' ? '#connections' : url.hash;
    const organizationReturn = organizationHistoryVisitReturn(fragment);
    if (
      organizationReturn &&
      (!subject ||
        subject[2] !== undefined ||
        organizationReturn.locale !== subject[1] ||
        organizationReturn.context !== selectedContext ||
        organizationReturn.realm !== (selectedRealm ?? undefined))
    )
      return;
    if (
      !(subject?.[2] === 'works' && creditReturn(fragment)) &&
      fragment !== '#literary-reader' &&
      !(subject && !subject[2] && (fragment === '#work-franchise' || workFranchiseReturn(fragment))) &&
      !(subject && !subject[2] && organizationHistoryVisitReturn(fragment)) &&
      fragment !== '#connections' &&
      !(subject && !subject[2] && fragment === '#supplied-names') &&
      !(subject && connectionReturnWindow(fragment)) &&
      !(subject && workCastVisitReturn(fragment)) &&
      !(subject && summaryReadingReturn(fragment)) &&
      fragment !== '#manga-reader' &&
      !(
        subject &&
        (!subject[2] || subject[2] === 'contents' || subject[2] === 'editions') &&
        mangaOccurrenceFromFragment(fragment)
      ) &&
      !(subject && (fragment === '#work-tags' || workTagReturn(fragment))) &&
      !(subject && subjectCommunityFragment.test(fragment)) &&
      fragment !== '#screen-episode-list' &&
      screenEntry === null &&
      !recordingStatement &&
      !(subject?.[2] === 'sources' && fragment === '#subject-sources-heading')
    )
      return;
    return `${url.pathname}${url.search}${fragment}`;
  } catch {
    return;
  }
}

/** A public return address may restore one admitted Subject or Collection view window. */
export function subjectVisitReturn(value: unknown, locale?: string): string | undefined {
  const release = releaseVisitReturn(value, locale);
  if (release) return release;
  return subjectVisitReturnAt(value, locale, false);
}

/** A thread-entry return may target only a real mounted community region on an admitted Subject route. */
export function subjectCommunityVisitReturn(value: unknown, locale?: string): string | undefined {
  const reading = realmReadingReturn(value, locale);
  if (reading) return reading;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  return subjectCommunityFragment.test(new URL(accepted, 'https://rezics.invalid').hash) ? accepted : undefined;
}

/** Bound route search by its fixed fields plus one validated opaque return address and current cursor. */
export function subjectRouteSearchLimit(search: string, cursor?: string): number {
  const parameters = new URLSearchParams(search);
  const via = parameters.get('via');
  const acceptedVia = via && via.length <= returnAddressCap ? subjectVisitReturn(via) : undefined;
  try {
    const currentCursor = cursor && cursor.length <= 8192 ? encodeURIComponent(cursor).length : 0;
    return 2048 + (acceptedVia ? encodeURIComponent(acceptedVia).length : 0) + currentCursor;
  } catch {
    return 2048;
  }
}

export function connectionReturnHref(
  id: string,
  label: string,
  locale: string,
  realm?: string,
  window?: ConnectionReturnWindow,
): string {
  const url = new URL(subjectHref({ id, label }, locale).href, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  return `${url.pathname}${url.search}${window ? connectionWindowFragment(window) : '#connections'}`;
}

export function withSubjectVisitReturn(href: string, value: string, locale: string): string {
  const via = subjectVisitReturn(value, locale);
  if (!via || !/^\/[^/]+\/subjects\//.test(href)) return href;
  const url = new URL(href, 'https://rezics.invalid');
  const existing = url.searchParams.getAll('via');
  if (existing.length === 1 && subjectVisitReturn(existing[0], locale)) return href;
  url.searchParams.set('via', via);
  return `${url.pathname}${url.search}${url.hash}`;
}
