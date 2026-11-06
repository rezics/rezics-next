import { isView, UI_LOCALES, type View } from '@rezics/composition';

const origin = 'https://rezics.invalid';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const configuredRoute = /^(?!subjects(?:\/|$))[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const maxCursorLength = 4864;
const cursorPattern = /^[A-Za-z0-9_-]{1,4864}$/;
const returnAddressCap = 32768;

export type ZoneVisitTarget = { kind: 'route'; route: string } | { kind: 'subject'; subject: string; view?: View };

export type ZoneVisit = {
  locale: string;
  zoneId: string;
  target: ZoneVisitTarget;
  cursor?: string;
};

export type ZonePageSearch = { cursor?: string };

/** Map a served Zone page target onto the existing visit record. Cursor is continuation, not identity. */
export function zoneVisitFromRequest(
  locale: string,
  zoneId: string,
  target: { route: string } | { subject: string; view?: View },
  cursor?: string,
): ZoneVisit {
  const visitTarget: ZoneVisitTarget =
    'route' in target
      ? { kind: 'route', route: target.route }
      : { kind: 'subject', subject: target.subject, ...(target.view ? { view: target.view } : {}) };
  return {
    locale,
    zoneId,
    target: visitTarget,
    ...(cursor ? { cursor } : {}),
  };
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function zoneConfiguredRoute(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return '';
  if (value.length > 255 || !configuredRoute.test(value)) return;
  return value;
}

export function validZoneCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxCursorLength && cursorPattern.test(value);
}

/** Invalid or oversized cursors are dropped so the reader restarts under current authority. */
export function zonePageSearch(search: Record<string, unknown>): ZonePageSearch {
  const keys = Object.keys(search);
  if (keys.some((key) => key !== 'cursor') || new Set(keys).size !== keys.length) return {};
  return validZoneCursor(search.cursor) ? { cursor: search.cursor } : {};
}

export function zoneHomeHref(locale: string, zoneId: string): string {
  return `/${encodeSegment(locale)}/zones/${encodeSegment(zoneId)}`;
}

export function zoneRouteHref(locale: string, zoneId: string, route = '', cursor?: string): string {
  const suffix = route ? `/${route.split('/').map(encodeSegment).join('/')}` : '';
  const href = `${zoneHomeHref(locale, zoneId)}${suffix}`;
  if (!cursor) return href;
  return `${href}?${new URLSearchParams({ cursor }).toString()}`;
}

export function zoneSubjectHref(
  locale: string,
  zoneId: string,
  subjectId: string,
  view: View | undefined = undefined,
): string {
  const base = `${zoneHomeHref(locale, zoneId)}/subjects/${encodeSegment(subjectId)}`;
  return view && view !== 'overview' ? `${base}/${encodeSegment(view)}` : base;
}

export function zoneVisitHref(visit: ZoneVisit): string {
  if (visit.target.kind === 'subject')
    return zoneSubjectHref(visit.locale, visit.zoneId, visit.target.subject, visit.target.view);
  return zoneRouteHref(visit.locale, visit.zoneId, visit.target.route, visit.cursor);
}

export function zoneListHref(visit: ZoneVisit, cursor?: string): string {
  const route = visit.target.kind === 'route' ? visit.target.route : '';
  return zoneRouteHref(visit.locale, visit.zoneId, route, cursor);
}

/** Drop continuation without assigning `cursor: undefined` under exact optional properties. */
export function zoneVisitWithoutCursor(visit: ZoneVisit): ZoneVisit {
  return { locale: visit.locale, zoneId: visit.zoneId, target: visit.target };
}

export function zoneLocationSearch(search: unknown): ZonePageSearch {
  if (search === null || typeof search !== 'object' || Array.isArray(search)) return {};
  return zonePageSearch(search as Record<string, unknown>);
}

export function zoneMemberHref(visit: ZoneVisit, subject: { id: string }): string {
  return zoneSubjectHref(visit.locale, visit.zoneId, subject.id);
}

function decodePath(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(decoded) ||
      decoded.split('/').some((segment) => segment === '.' || segment === '..')
    )
      return;
    return decoded;
  } catch {
    return;
  }
}

/** Public locators only: locale, Zone, configured route or admitted subject, optional opaque cursor. */
export function zoneVisitReturn(value: unknown, locale?: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > returnAddressCap ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u0020\u007f]/u.test(value)
  )
    return;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.hash) return;
    const parts = url.pathname.split('/');
    if (parts.length < 4 || parts[0] !== '' || parts[2] !== 'zones') return;
    const language = decodePath(parts[1] ?? '');
    const zoneId = decodePath(parts[3] ?? '');
    if (
      !language ||
      !UI_LOCALES.includes(language as (typeof UI_LOCALES)[number]) ||
      (locale !== undefined && locale !== language) ||
      !zoneId ||
      !uuid.test(zoneId)
    )
      return;
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== 'cursor') || new Set(keys).size !== keys.length) return;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && !validZoneCursor(cursor)) return;
    if (parts.length === 4) {
      const href = zoneRouteHref(language, zoneId, '', cursor ?? undefined);
      return cursor ? href : zoneHomeHref(language, zoneId);
    }
    if (parts[4] === 'subjects') {
      if (cursor !== null || parts.length < 6 || parts.length > 7) return;
      const subjectId = decodePath(parts[5] ?? '');
      if (!subjectId || !uuid.test(subjectId)) return;
      if (parts.length === 6) return zoneSubjectHref(language, zoneId, subjectId);
      const view = decodePath(parts[6] ?? '');
      if (!view || !isView(view) || view === 'overview') return;
      return zoneSubjectHref(language, zoneId, subjectId, view);
    }
    const route = parts
      .slice(4)
      .map((segment) => decodePath(segment))
      .join('/');
    if (zoneConfiguredRoute(route) !== route) return;
    return zoneRouteHref(language, zoneId, route, cursor ?? undefined);
  } catch {
    return;
  }
}

export function parseZoneVisit(href: string, locale?: string): ZoneVisit | undefined {
  const accepted = zoneVisitReturn(href, locale);
  if (!accepted) return;
  const url = new URL(accepted, origin);
  const parts = url.pathname.split('/');
  const language = decodeURIComponent(parts[1]!);
  const zoneId = decodeURIComponent(parts[3]!);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (parts[4] === 'subjects') {
    const subject = decodeURIComponent(parts[5]!);
    const view = parts[6] ? (decodeURIComponent(parts[6]) as View) : undefined;
    return {
      locale: language,
      zoneId,
      target: { kind: 'subject', subject, ...(view ? { view } : {}) },
    };
  }
  const route = parts
    .slice(4)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
  return {
    locale: language,
    zoneId,
    target: { kind: 'route', route },
    ...(cursor ? { cursor } : {}),
  };
}

/** A later Zone revision or different target cannot reuse another visit's continuation. */
export function zoneVisitIdentity(visit: ZoneVisit, revision?: string): string {
  return JSON.stringify([visit.locale, visit.zoneId, visit.target, revision ?? null]);
}

export function retainZoneCursor(visit: ZoneVisit, identity: string, revision?: string): string | undefined {
  return zoneVisitIdentity(visit, revision) === identity ? visit.cursor : undefined;
}
