import type { LibraryProfile, LibraryProfileReference, TypeDefinition } from '@rezics/definitions';
import type { FilterRelease } from '@rezics/filter';
import { parseCoverRatio, type CoverRatio } from '@rezics/ui/cover';
import { env } from 'cloudflare:workers';
import { requestLocale } from '../kernel/client.ts';
import { relationDefinitions, type RelationDefinition } from './relations.ts';
import type { KernelClient } from '@rezics/client';
import { fetchGuideRelease, type GuideRelease } from '../features/catalogue/definition-guide';
import { readTypeDescriptor, readTypeDescriptors } from '../features/catalogue/type-directory';

export type Release = FilterRelease & {
  digest?: string;
  libraryProfiles?: Record<string, LibraryProfile>;
  types: Record<
    string,
    {
      labels?: Record<string, string>;
      descriptions?: Record<string, string>;
      bases?: readonly string[];
      properties?: readonly string[];
      facets?: readonly string[];
      schemaOrgType?: string;
      coverRatio?: string;
      listPresentation?: TypeDefinition['listPresentation'];
      library?: LibraryProfileReference;
    }
  >;
  properties: Record<
    string,
    {
      labels?: Record<string, string>;
      datatype: string;
      multivalued?: boolean;
      targets?: readonly string[];
      units?: readonly string[];
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

/** Caller-aware release reads retain native failures and bypass the anonymous display cache. */
export async function readReleaseForCaller(options: {
  client: KernelClient;
  digest?: string;
  headers?: Record<string, string>;
}): Promise<GuideRelease> {
  return fetchGuideRelease(options.client, options.digest, options.headers);
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
      return { ...value, digest: active.digest, types } as unknown as Release;
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

/** Revalidate the active pointer after a command rejects values; immutable releases retain their normal cache. */
export async function refreshRelease(): Promise<Release> {
  const url = new URL('/v1/definitions/active', kernelOrigin()).href;
  definitionMemory.delete(url);
  const cache = typeof caches === 'undefined' ? undefined : (caches as unknown as { default?: Cache }).default;
  if (cache) await cache.delete(new Request(url, { method: 'GET' }));
  return readRelease();
}

/** Current released names for only the requested Types, including Types from other active Releases. */
export async function typeNames(types: Iterable<string>, locale: string): Promise<Map<string, string>> {
  const descriptors = await readTypeDescriptors(types, locale);
  return new Map(
    [...descriptors].flatMap(([type, descriptor]) =>
      descriptor.label
        ? [[type, displayTypeLabel(descriptor.label, descriptor.language ?? locale)] as const]
        : [],
    ),
  );
}

/** Effective cover inheritance is compiled into the exact descriptor; schema metadata is explicit only. */
export async function typeFrame(
  type: string,
  locale: string,
): Promise<{ label?: string; ratio?: CoverRatio; schemaOrgType?: string }> {
  const result = await readTypeDescriptor(type, locale);
  if (!result.ok) return {};
  const { label, language, definition } = result.descriptor;
  const ratio = typeof definition.coverRatio === 'string' ? parseCoverRatio(definition.coverRatio) : undefined;
  const schemaOrgType =
    typeof definition.schemaOrgType === 'string' &&
    /^https:\/\/schema\.org\/[A-Za-z0-9_-]+$(?![\s\S])/u.test(definition.schemaOrgType)
      ? definition.schemaOrgType
      : undefined;
  return {
    ...(label ? { label: displayTypeLabel(label, language ?? locale) } : {}),
    ...(ratio === undefined ? {} : { ratio }),
    ...(schemaOrgType === undefined ? {} : { schemaOrgType }),
  };
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
    else delete subject.typeLabel;
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
