import { describe, expect, test } from 'bun:test';
import { discoverCatalogs } from '../../../scripts/i18n/check.ts';

/**
 * Phrases that use a service's word for something a reader already knows.
 * "Main Version" is a release, "Main navigation" is the landmark, and the rest
 * name content or an access grant. Stripped before the whole-word scan so a
 * later "Main refused" still fails.
 */
const domainPhrases = [
  'Main Version',
  'Main navigation',
  'Main characters',
  'Main entry',
  'Content moderation',
  'Content languages',
  'Content preferences',
  'Access given',
  'Access removed',
  'Access and discovery',
];

/** A label whose whole text is the domain word, not the service. */
const domainLabels = new Set(['Content']);

// ASCII word boundaries, so "Main" still matches when a CJK particle follows it.
const serviceName = /\b(?:Main|Access|Content|Fuseki|Jena)\b|\bAccount relay\b/g;

function serviceNames(text: string): string[] {
  if (domainLabels.has(text.trim())) return [];
  let masked = text;
  for (const phrase of domainPhrases) masked = masked.replaceAll(phrase, ' ');
  return [...masked.matchAll(serviceName)].map(match => match[0]);
}

function textsOf(value: unknown, out: string[] = [], seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'function') {
    out.push(Function.prototype.toString.call(value));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  for (const child of Object.values(value)) textsOf(child, out, seen);
  return out;
}

describe('G-900 catalogs do not name an internal service', () => {
  test('service names match as whole words, and the domain phrases do not', () => {
    expect(serviceNames('Main didn’t answer')).toEqual(['Main']);
    expect(serviceNames('Main에서 응답하지 않았어요')).toEqual(['Main']);
    expect(serviceNames('The server didn’t answer')).toEqual([]);
    expect(serviceNames('Main Version in {{language}}')).toEqual([]);
    expect(serviceNames('story (Main Version)')).toEqual([]);
    expect(serviceNames('Main navigation')).toEqual([]);
    expect(serviceNames('Main characters')).toEqual([]);
    expect(serviceNames('Main entry')).toEqual([]);
    expect(serviceNames('Content')).toEqual([]);
    expect(serviceNames('Content languages')).toEqual([]);
    expect(serviceNames('Content moderation')).toEqual([]);
    expect(serviceNames('Content preferences')).toEqual([]);
    expect(serviceNames('The Content service didn’t answer')).toEqual(['Content']);
    expect(serviceNames('Access given {{date}}')).toEqual([]);
    expect(serviceNames('Access removed')).toEqual([]);
    expect(serviceNames('Access and discovery')).toEqual([]);
    expect(serviceNames('Access refused this change')).toEqual(['Access']);
    expect(serviceNames('Account relay timed out')).toEqual(['Account relay']);
    expect(serviceNames('Fuseki is down')).toEqual(['Fuseki']);
    expect(serviceNames('Ask Jena')).toEqual(['Jena']);
    expect(serviceNames('your access to this content')).toEqual([]);
  });

  test('every message catalog, in every locale, avoids those names', async () => {
    const catalogs = await discoverCatalogs();
    expect(catalogs.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const catalog of catalogs) {
      if (catalog.loadError) found.push(`${catalog.id}: ${catalog.loadError}`);
      const bodies = [...Object.entries(catalog.locales), ...Object.entries(catalog.resolved ?? {})];
      for (const [locale, body] of bodies) {
        for (const text of textsOf(body)) {
          const names = serviceNames(text);
          if (names.length) found.push(`${catalog.id} ${locale}: ${names.join(', ')} in ${text}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
