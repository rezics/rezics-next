import { createContext } from 'react';

export type ZoneDestinations = {
  zoneId: string;
  locale: string;
  route: string;
  cursor?: string;
};

export const ZoneDestinationsContext = createContext<ZoneDestinations | null>(null);

export function zoneRouteHref(locale: string, zoneId: string, route = '', cursor?: string, list?: string): string {
  const suffix = route ? `/${route.split('/').map(encodeURIComponent).join('/')}` : '';
  const path = `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zoneId)}${suffix}`;
  const params = new URLSearchParams();
  if (list) params.set('list', list);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function zoneSubjectHref(locale: string, zoneId: string, subjectId: string, view?: string): string {
  const base = `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zoneId)}/subjects/${encodeURIComponent(subjectId)}`;
  return view && view !== 'overview' ? `${base}/${encodeURIComponent(view)}` : base;
}

export function zoneReturnHref(locale: string, zoneId: string, route = ''): string {
  return zoneRouteHref(locale, zoneId, route);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,4864}$/;
const listPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function zonePageSearch(search: string): { cursor?: string; list?: string } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const cursor = params.get('cursor') ?? undefined;
  const list = params.get('list') ?? undefined;
  return {
    ...(cursor && cursorPattern.test(cursor) ? { cursor } : {}),
    ...(list && listPattern.test(list) ? { list } : {}),
  };
}

export function isZoneSubjectId(value: string): boolean {
  return uuid.test(value);
}
