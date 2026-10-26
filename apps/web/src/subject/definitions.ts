import { pickText } from '@rezics/composition';
import type { FilterRelease } from '@rezics/filter';
import { env } from 'cloudflare:workers';
import { requestLocale } from '../kernel/client.ts';

export type Release = FilterRelease & {
  types: Record<string, { labels?: Record<string, string>; bases?: readonly string[]; facets?: readonly string[] }>;
  properties: Record<string, { labels?: Record<string, string>; datatype: string; value?: { pattern?: string } }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const definitionMemory = new Map<string, { storedAt: number; value: unknown }>();

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
  const releaseUrl = new URL(`/v1/definitions/releases/${encodeURIComponent(active.digest)}`, origin).href;
  const response = await cachedDefinition<{ digest?: unknown; release?: unknown }>(releaseUrl);
  const value = response.release;
  if (response.digest !== active.digest || !isRecord(value) || !isRecord(value.types) || !isRecord(value.properties))
    throw new Error('Definitions release is invalid');
  return value as unknown as Release;
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
