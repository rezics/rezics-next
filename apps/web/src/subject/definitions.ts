import { pickText } from '@rezics/composition';
import type { FilterRelease } from '@rezics/filter';
import { env } from 'cloudflare:workers';
import { requestLocale } from '../kernel/client.ts';
import { relationDefinitions, type RelationDefinition } from './relations.ts';

export type Release = FilterRelease & {
  types: Record<
    string,
    { labels?: Record<string, string>; bases?: readonly string[]; facets?: readonly string[]; coverRatio?: string }
  >;
  properties: Record<
    string,
    {
      labels?: Record<string, string>;
      datatype: string;
      value?: { pattern?: string };
      relation?: { group?: string; symmetric?: boolean; inverseLabels?: Record<string, string> };
    }
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A type's display name: uppercase its first Unicode character in its language, leaving the rest as released. */
export function displayTypeLabel(label: string, locale: string): string {
  const codePoint = label.codePointAt(0);
  if (codePoint === undefined) return label;
  const first = String.fromCodePoint(codePoint);
  return `${first.toLocaleUpperCase(locale)}${label.slice(first.length)}`;
}

const definitionMemory = new Map<string, { storedAt: number; value: unknown }>();
const displayReleaseMemory = new Map<string, Promise<Release>>();

async function cachedDefinition<T>(url: string, ttl?: number): Promise<T> {
  const now = Date.now();
  const remembered = definitionMemory.get(url);
  const cache = typeof caches === 'undefined' ? undefined : (caches as unknown as { default?: Cache }).default;
  const request = new Request(url, { method: 'GET' });

  if (cache) {
    try {
      const cached = await cache.match(request);
      if (cached) {
        const storedAt = Number(cached.headers.get('x-rezics-definition-stored-at'));
        if (ttl === undefined || (Number.isFinite(storedAt) && now - storedAt < ttl)) {
          const value = (await cached.json()) as T;
          definitionMemory.set(url, { storedAt: Number.isFinite(storedAt) ? storedAt : now, value });
          return value;
        }
        await cache.delete(request);
      }
    } catch {
      // The memory copy below keeps local development working if the Cache API is unavailable.
    }
  }

  if (remembered && (ttl === undefined || now - remembered.storedAt < ttl)) return remembered.value as T;

  const response = await fetch(request);
  if (!response.ok) throw new Error('Definitions read failed');
  const value = (await response.json()) as T;
  const storedAt = Date.now();
  definitionMemory.set(url, { storedAt, value });
  if (cache) {
    const cacheHeaders = new Headers({
      'content-type': 'application/json',
      'cache-control': ttl === undefined ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      'x-rezics-definition-stored-at': String(storedAt),
    });
    try {
      await cache.put(request, new Response(JSON.stringify(value), { headers: cacheHeaders }));
    } catch {
      // Some local Cache API implementations reject entries; the bounded memory copy is the fallback.
    }
  }
  return value;
}

function kernelOrigin(): string {
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (origin) return origin;
  if (import.meta.env.DEV) return 'http://kernel.local';
  throw new Error('KERNEL_ORIGIN is required to read definitions');
}

export async function readRelease(): Promise<Release> {
  const origin = kernelOrigin();
  const activeUrl = new URL('/v1/definitions/active', origin).href;
  const active = await cachedDefinition<{ digest?: unknown }>(activeUrl, 60_000);
  if (typeof active.digest !== 'string' || active.digest.length === 0 || active.digest.length > 256)
    throw new Error('Active definitions release is invalid');
  let pending = displayReleaseMemory.get(active.digest);
  if (!pending) {
    const releaseUrl = new URL(`/v1/definitions/releases/${encodeURIComponent(active.digest)}`, origin).href;
    pending = (async () => {
      const response = await cachedDefinition<{ digest?: unknown; release?: unknown }>(releaseUrl);
      const value = response.release;
      if (
        response.digest !== active.digest ||
        !isRecord(value) ||
        !isRecord(value.types) ||
        !isRecord(value.properties)
      )
        throw new Error('Definitions release is invalid');
      const types = Object.fromEntries(
        Object.entries(value.types).map(([type, definition]) => {
          if (!isRecord(definition) || !isRecord(definition.labels)) return [type, definition];
          const labels = Object.fromEntries(
            Object.entries(definition.labels).map(([locale, label]) => [
              locale,
              typeof label === 'string' ? displayTypeLabel(label, locale) : label,
            ]),
          );
          return [type, { ...definition, labels }];
        }),
      );
      return { ...value, types } as unknown as Release;
    })();
    displayReleaseMemory.set(active.digest, pending);
  }
  try {
    return await pending;
  } catch (error) {
    if (displayReleaseMemory.get(active.digest) === pending) displayReleaseMemory.delete(active.digest);
    throw error;
  }
}

/** The definition release's name for each of these types in the reader's language chain; a type it has no name for is absent. */
export async function typeNames(types: Iterable<string>, locale: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = new Set(types);
  if (wanted.size === 0) return names;
  let release: Release;
  try {
    release = await readRelease();
  } catch {
    return names;
  }
  for (const type of wanted) {
    const definition = Object.hasOwn(release.types, type) ? release.types[type] : undefined;
    const label = definition?.labels ? pickText(definition.labels, locale).text : '';
    if (label) names.set(type, label);
  }
  return names;
}

const coverRatios = new Set<string>(['2:3', '3:4', '1:1', '4:3']);

/**
 * The type's name in the reader's language and the cover frame its definition declares, taken from the nearest type
 * of its own bases that declares one. A type the release does not know has neither.
 */
export async function typeFrame(
  type: string,
  locale: string,
): Promise<{ label?: string; ratio?: '2:3' | '3:4' | '1:1' | '4:3' }> {
  let release: Release;
  try {
    release = await readRelease();
  } catch {
    return {};
  }
  const definition = Object.hasOwn(release.types, type) ? release.types[type] : undefined;
  if (!definition) return {};
  const label = definition.labels ? pickText(definition.labels, locale).text : '';
  for (const name of [type, ...(definition.bases ?? [])]) {
    const ratio = Object.hasOwn(release.types, name) ? release.types[name]?.coverRatio : undefined;
    if (ratio !== undefined && coverRatios.has(ratio))
      return { ...(label ? { label } : {}), ratio: ratio as '2:3' | '3:4' | '1:1' | '4:3' };
  }
  return label ? { label } : {};
}

/** Names each subject's type in the reader's language, in place; a type with no name keeps none and is not shown. */
export async function nameSubjectTypes(
  subjects: Iterable<{ type: string; typeLabel?: string } | null | undefined>,
): Promise<void> {
  const present = [...subjects].filter((subject) => subject != null);
  const names = await typeNames(
    present.map((subject) => subject.type),
    requestLocale() ?? 'en',
  );
  for (const subject of present) {
    const name = names.get(subject.type);
    if (name !== undefined) subject.typeLabel = name;
  }
}

/** How each relation property reads on a page, from the active release; with no release every property is unknown. */
export async function relationLabels(
  properties: Iterable<string>,
  locale: string,
): Promise<Record<string, RelationDefinition>> {
  const wanted = [...new Set(properties)];
  if (wanted.length === 0) return {};
  try {
    return relationDefinitions(await readRelease(), wanted, locale);
  } catch {
    return {};
  }
}
