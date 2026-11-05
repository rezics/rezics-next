// SPDX-License-Identifier: Apache-2.0
import type {
  CompositionDocument,
  CompositionRegistry,
  CompositionViolation,
  CompositionViolationCode,
} from './registry.ts';
import { PLAIN_TEXT } from './strings.ts';
import { validateComposition } from './validate.ts';

export const UI_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export const MAX_ZONE_PAGES = 16;
export const MAX_ZONE_SCOPE = 16;

export type ZoneStarter = {
  labels: Record<(typeof UI_LOCALES)[number], string>;
  pages: { route: string; document: CompositionDocument }[];
  scope: string[];
};

/** Saved Zones add naming metadata without changing inert starter or composition labels. */
export type ZoneLanguage = (typeof UI_LOCALES)[number];
export type ZoneConfiguration = Omit<ZoneStarter, 'labels'> & {
  labels: Partial<Record<ZoneLanguage, string>>;
  primaryLanguage?: ZoneLanguage;
};

/** Legacy order is explicit and independent of object insertion order or interface language. */
export function zonePrimaryLanguage(
  zone: Pick<ZoneConfiguration, 'labels' | 'primaryLanguage'>,
): ZoneLanguage | undefined {
  return zone.primaryLanguage ?? UI_LOCALES.find((language) => !!zone.labels[language]?.trim());
}

/** Consume only the caller's readable map; this function cannot recover withheld names. */
export function pickZoneName(
  zone: Pick<ZoneConfiguration, 'labels' | 'primaryLanguage'>,
  requested: string,
): { text: string; lang?: string } {
  const language =
    UI_LOCALES.find((language) => language === requested && !!zone.labels[language]?.trim()) ??
    (zone.primaryLanguage && zone.labels[zone.primaryLanguage]?.trim() ? zone.primaryLanguage : undefined) ??
    (zone.primaryLanguage === undefined ? UI_LOCALES.find((language) => !!zone.labels[language]?.trim()) : undefined);
  return language ? { text: zone.labels[language]!, lang: language } : { text: '' };
}

export function validateZoneConfiguration(
  registry: CompositionRegistry,
  value: unknown,
  options: { filters: ReadonlySet<string> },
): CompositionViolation[] {
  return validateZoneEnvelope(registry, value, options, true);
}

const STARTER_KEYS = new Set(['labels', 'pages', 'scope']);
const LOCALE_KEYS = new Set<string>(UI_LOCALES);
const ROUTE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?(?![\s\S])/u;
const PRIORITY: Record<CompositionViolationCode, number> = {
  limit: 4,
  unsafe: 3,
  duplicate: 2,
  unknown_type: 2,
  invalid: 1,
};

type Add = (pointer: string, code: CompositionViolationCode) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function token(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function join(pointer: string, segment: string | number): string {
  return `${pointer}/${typeof segment === 'number' ? segment : token(segment)}`;
}

function addViolation(
  found: Map<string, CompositionViolationCode>,
  pointer: string,
  code: CompositionViolationCode,
): void {
  const current = found.get(pointer);
  if (current === undefined || PRIORITY[code] > PRIORITY[current]) found.set(pointer, code);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function finish(found: Map<string, CompositionViolationCode>): CompositionViolation[] {
  return [...found.entries()]
    .map(([pointer, code]) => ({ pointer, code }))
    .sort((left, right) => (left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0))
    .slice(0, 64);
}

/** Checks inert Zone starter data without changing it or instantiating any Zone state. */
export function validateZoneStarter(
  registry: CompositionRegistry,
  value: unknown,
  options: { filters: ReadonlySet<string> },
): CompositionViolation[] {
  return validateZoneEnvelope(registry, value, options, false);
}

function validateZoneEnvelope(
  registry: CompositionRegistry,
  value: unknown,
  options: { filters: ReadonlySet<string> },
  saved: boolean,
): CompositionViolation[] {
  try {
    if (!isPlainObject(value)) return [{ pointer: '', code: 'invalid' }];

    const found = new Map<string, CompositionViolationCode>();
    const add: Add = (pointer, code) => addViolation(found, pointer, code);

    for (const key of Object.keys(value)) {
      if (!STARTER_KEYS.has(key) && !(saved && key === 'primaryLanguage')) add(join('', key), 'invalid');
    }
    for (const key of STARTER_KEYS) {
      if (!Object.hasOwn(value, key)) add(join('', key), 'invalid');
    }

    const pages = value.pages;
    const scope = value.scope;
    const pagesOverLimit = Array.isArray(pages) && pages.length > MAX_ZONE_PAGES;
    const scopeOverLimit = Array.isArray(scope) && scope.length > MAX_ZONE_SCOPE;
    if (pagesOverLimit) add('/pages', 'limit');
    if (scopeOverLimit) add('/scope', 'limit');

    const primary = saved ? value.primaryLanguage : undefined;
    if (primary !== undefined && (typeof primary !== 'string' || !LOCALE_KEYS.has(primary)))
      add('/primaryLanguage', 'invalid');
    const labels = value.labels;
    if (!isPlainObject(labels)) {
      add('/labels', 'invalid');
    } else {
      for (const key of Object.keys(labels)) {
        if (!LOCALE_KEYS.has(key)) add(join('/labels', key), 'invalid');
      }
      for (const locale of UI_LOCALES) {
        const pointer = join('/labels', locale);
        if (!Object.hasOwn(labels, locale)) {
          if (primary === undefined || primary === locale) add(pointer, 'invalid');
          continue;
        }
        const label = labels[locale];
        if (typeof label !== 'string') {
          add(pointer, 'invalid');
        } else if (!PLAIN_TEXT.test(label)) {
          add(pointer, 'unsafe');
        } else if ((saved ? !label.trim() : label.length === 0) || codePointLength(label) > 80) {
          add(pointer, 'invalid');
        }
      }
    }

    if (!Array.isArray(pages)) {
      add('/pages', 'invalid');
    } else if (!pagesOverLimit) {
      let hasHome = false;
      let previousRoute: string | undefined;
      for (let index = 0; index < pages.length; index++) {
        const entry = pages[index];
        const entryPointer = join('/pages', index);
        if (!isPlainObject(entry)) {
          add(entryPointer, 'invalid');
          previousRoute = undefined;
          continue;
        }
        const keys = Object.keys(entry);
        if (keys.length !== 2 || !Object.hasOwn(entry, 'route') || !Object.hasOwn(entry, 'document')) {
          add(entryPointer, 'invalid');
          previousRoute = undefined;
          continue;
        }

        const route = entry.route;
        if (typeof route !== 'string' || route.length > 255 || !ROUTE.test(route)) {
          add(join(entryPointer, 'route'), 'invalid');
        } else {
          if (route === '') hasHome = true;
        }
        if (typeof route === 'string' && previousRoute !== undefined) {
          if (route === previousRoute) add(join(entryPointer, 'route'), 'duplicate');
          else if (route < previousRoute) add(join(entryPointer, 'route'), 'invalid');
        }
        previousRoute = typeof route === 'string' ? route : undefined;

        const documentPointer = join(entryPointer, 'document');
        let documentViolations: CompositionViolation[];
        try {
          documentViolations = validateComposition(registry, entry.document);
        } catch {
          add(documentPointer, 'invalid');
          continue;
        }
        for (const violation of documentViolations) {
          const pointer = violation.pointer === '' ? documentPointer : `${documentPointer}${violation.pointer}`;
          add(pointer, violation.code);
        }
      }
      if (!hasHome) add('/pages', 'invalid');
    }

    if (!Array.isArray(scope)) {
      add('/scope', 'invalid');
    } else if (!scopeOverLimit) {
      const seen = new Set<string>();
      for (let index = 0; index < scope.length; index++) {
        const id = scope[index];
        const pointer = join('/scope', index);
        if (typeof id !== 'string' || !options.filters.has(id)) {
          add(pointer, 'invalid');
          continue;
        }
        if (seen.has(id)) add(pointer, 'duplicate');
        else seen.add(id);
      }
    }

    return finish(found);
  } catch {
    // Parsed JSON and a release-owned registry/filter set should not reach this path.
    return [{ pointer: '', code: 'invalid' }];
  }
}
