import { pickZoneName } from '@rezics/composition';
import { m } from '../paraglide/messages.js';
import type { ZonePublic } from './appearance';

export function zoneLabel(zone: ZonePublic, locale: string): { text: string; lang?: string } | undefined {
  const label = pickZoneName(zone, locale);
  if (!label.text) return;
  return { text: label.text, ...(label.lang ? { lang: label.lang } : {}) };
}

function navigationLabel(route: string, locale: string): string {
  if (!route) return m.zone_home();
  const segment = route.split('/').at(-1) ?? route;
  return segment.replaceAll('-', ' ').replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase(locale));
}

export function zoneRouteHeading(route: string, locale: string): string {
  return navigationLabel(route, locale);
}

export function zonePageTitle(zone: ZonePublic, route: string, locale: string): string {
  const title = zoneLabel(zone, locale)?.text ?? m.zone_home();
  return route ? `${navigationLabel(route, locale)} · ${title}` : title;
}
