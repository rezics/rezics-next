import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { createTypes } from './create-subject';

export type GuideRelease = Pick<Release, 'types' | 'properties'> & { digest: string };
export type GuideLocale = 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant';
export type GuideAddress = {
  type?: string | undefined;
  property?: string | undefined;
  release?: string | undefined;
  returnTo?: string | undefined;
};
export type GuideFailure = 'denied' | 'concealed' | 'invalid' | 'unavailable' | 'no-match' | 'stale';
export type GuideTypeSummary = {
  typeId: string;
  releaseDigest: string;
  label: string;
  language: string | null;
  parents: string[];
  description: string | null;
  descriptionLanguage: string | null;
};
export type GuideDirectoryPage = { types: GuideTypeSummary[]; next: string | null };
export type GuideTypeDescriptor = GuideTypeSummary & {
  definition: Release['types'][string];
  properties: Record<string, PropertyDefinition>;
};
export type GuidePageRead = { ok: false; reason: GuideFailure } | { ok: true; page: GuideDirectoryPage };
export type GuideTypeRead = { ok: false; reason: GuideFailure } | { ok: true; descriptor: GuideTypeDescriptor };
export type GuideRead =
  | { ok: false; reason: GuideFailure }
  | { ok: true; release: GuideRelease; pin: 'pinned' }
  | { ok: true; page: GuideDirectoryPage; pin: 'active' }
  | { ok: true; descriptor: GuideTypeDescriptor; pin: 'active' };
export type GuideTransport = {
  read: (locale?: GuideLocale) => Promise<GuideRead>;
  directory: (locale: GuideLocale, query: string, cursor?: string) => Promise<GuidePageRead>;
  exact: (locale: GuideLocale, typeId: string) => Promise<GuideTypeRead>;
};

export class DefinitionReadError extends Error {
  constructor(public readonly reason: GuideFailure) {
    super(`Definitions ${reason}`);
  }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const guidePageSize = 20;
export const guideIdentifierLimit = 4_194_304;
export const guideLocales: readonly GuideLocale[] = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const textMap = (value: unknown) => record(value) && Object.values(value).every((text) => typeof text === 'string');
const strings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Validate the presentation surface; the producer owns release compilation and semantic validation. */
function releasedMetadata(value: unknown): value is Pick<Release, 'types' | 'properties'> {
  if (!record(value) || !record(value.types) || !record(value.properties)) return false;
  return (
    Object.values(value.types).every(
      (type) =>
        record(type) &&
        textMap(type.labels) &&
        strings(type.properties) &&
        (type.descriptions === undefined || textMap(type.descriptions)),
    ) &&
    Object.values(value.properties).every(
      (property) =>
        record(property) &&
        textMap(property.labels) &&
        typeof property.datatype === 'string' &&
        typeof property.multivalued === 'boolean' &&
        strings(property.qualifiers) &&
        record(property.value) &&
        (property.descriptions === undefined || textMap(property.descriptions)) &&
        (property.targets === undefined || strings(property.targets)) &&
        (property.units === undefined || strings(property.units)),
    )
  );
}

function requireSuccess(status: number): void {
  if (status === 200) return;
  throw new DefinitionReadError(
    status === 401
      ? 'denied'
      : status === 403 || status === 404
        ? 'concealed'
        : status === 400 || status === 422
          ? 'invalid'
          : 'unavailable',
  );
}

function requireDirectorySuccess(status: number, exact = false): void {
  if (status === 200) return;
  if (status === 404 && exact) throw new DefinitionReadError('no-match');
  if (status === 409) throw new DefinitionReadError('stale');
  requireSuccess(status);
}

type KernelResult = { status: number; data?: unknown };
type TypeDirectoryClient = {
  definitionTypes: {
    get(options: {
      query: { locale: GuideLocale; limit: number; query?: string; cursor?: string };
      headers?: Record<string, string>;
    }): Promise<KernelResult>;
    (params: { typeId: string }): {
      get(options: { query: { locale: GuideLocale }; headers?: Record<string, string> }): Promise<KernelResult>;
    };
  };
};

function typeSummary(value: unknown): value is GuideTypeSummary {
  return (
    record(value) &&
    typeof value.typeId === 'string' &&
    typeof value.releaseDigest === 'string' &&
    digestPattern.test(value.releaseDigest) &&
    typeof value.label === 'string' &&
    (typeof value.language === 'string' || value.language === null) &&
    strings(value.parents) &&
    (typeof value.description === 'string' || value.description === null) &&
    (typeof value.descriptionLanguage === 'string' || value.descriptionLanguage === null)
  );
}

function directoryPage(value: unknown): value is GuideDirectoryPage {
  return (
    record(value) &&
    Array.isArray(value.types) &&
    value.types.length <= guidePageSize &&
    value.types.every(typeSummary) &&
    (typeof value.next === 'string' || value.next === null)
  );
}

function typeDescriptor(value: unknown): value is GuideTypeDescriptor {
  if (!typeSummary(value) || !record(value)) return false;
  const descriptor = value as Record<string, unknown>;
  const definition = descriptor.definition;
  const properties = descriptor.properties;
  if (!record(definition) || !record(properties)) return false;
  if (!releasedMetadata({ types: { [value.typeId]: definition }, properties })) return false;
  const typedDefinition = definition as Release['types'][string];
  return strings(typedDefinition.properties) && typedDefinition.properties.every((id) => Object.hasOwn(properties, id));
}

/** Generated native GETs, with current caller headers. Never cache a caller's authority or guess a release file. */
export async function fetchGuideRelease(
  client: KernelClient,
  digest?: string,
  headers: Record<string, string> = {},
): Promise<GuideRelease> {
  if (digest !== undefined && !digestPattern.test(digest)) throw new DefinitionReadError('invalid');
  let selected = digest;
  if (selected === undefined) {
    const active = await client.definitions.active.get({ headers });
    requireSuccess(active.status);
    selected = active.data?.digest;
  }
  if (!selected || !digestPattern.test(selected)) throw new DefinitionReadError('invalid');
  const response = await client.definitions.releases({ digest: selected }).get({ headers });
  requireSuccess(response.status);
  if (response.data?.digest !== selected || !releasedMetadata(response.data.release))
    throw new DefinitionReadError('invalid');
  return { ...response.data.release, digest: selected };
}

/** Read only one bounded active-directory page. Cursor bindings remain owned by Kernel. */
export async function fetchGuideDirectory(
  client: KernelClient,
  locale: GuideLocale,
  query = '',
  cursor?: string,
  headers: Record<string, string> = {},
): Promise<GuideDirectoryPage> {
  if (query.length > 512 || (cursor !== undefined && cursor.length > 4096)) throw new DefinitionReadError('invalid');
  const directory = (client as unknown as TypeDirectoryClient).definitionTypes;
  const response = await directory.get({
    query: { locale, limit: guidePageSize, query, ...(cursor === undefined ? {} : { cursor }) },
    headers,
  });
  requireDirectorySuccess(response.status);
  if (!directoryPage(response.data)) throw new DefinitionReadError('invalid');
  return response.data;
}

/** Read one exact active Type descriptor; never fetch or enumerate its Release. */
export async function fetchGuideType(
  client: KernelClient,
  typeId: string,
  locale: GuideLocale,
  headers: Record<string, string> = {},
): Promise<GuideTypeDescriptor> {
  if (typeId.length === 0 || typeId.length > guideIdentifierLimit) throw new DefinitionReadError('invalid');
  const route = (client as unknown as TypeDirectoryClient).definitionTypes({ typeId });
  const response = await route.get({ query: { locale }, headers });
  requireDirectorySuccess(response.status, true);
  if (!typeDescriptor(response.data) || response.data.typeId !== typeId) throw new DefinitionReadError('invalid');
  return response.data;
}

function failure(error: unknown, exact = false): GuideFailure {
  if (error instanceof DefinitionReadError) return error.reason;
  if (exact && typeof error === 'object' && error !== null && 'status' in error && error.status === 404)
    return 'no-match';
  return 'unavailable';
}

export async function readGuideDirectory(
  client: KernelClient,
  locale: GuideLocale,
  query = '',
  cursor?: string,
  headers: Record<string, string> = {},
): Promise<GuidePageRead> {
  try {
    return { ok: true, page: await fetchGuideDirectory(client, locale, query, cursor, headers) };
  } catch (error) {
    return { ok: false, reason: failure(error) };
  }
}

export async function readGuideType(
  client: KernelClient,
  typeId: string,
  locale: GuideLocale,
  headers: Record<string, string> = {},
): Promise<GuideTypeRead> {
  try {
    return { ok: true, descriptor: await fetchGuideType(client, typeId, locale, headers) };
  } catch (error) {
    return { ok: false, reason: failure(error, true) };
  }
}

export async function readGuide(
  address: GuideAddress,
  readRelease: (digest?: string) => Promise<GuideRelease>,
  readDirectory: () => Promise<GuidePageRead>,
  readType: (typeId: string) => Promise<GuideTypeRead>,
): Promise<GuideRead> {
  try {
    if (address.release !== undefined && !digestPattern.test(address.release)) return { ok: false, reason: 'invalid' };
    if (address.property && !address.type) return { ok: false, reason: 'invalid' };
    if (address.release !== undefined) {
      const release = await readRelease(address.release);
      if (address.type && !Object.hasOwn(release.types, address.type)) return { ok: false, reason: 'invalid' };
      if (
        address.property &&
        (!release.types[address.type!]?.properties.includes(address.property) ||
          !Object.hasOwn(release.properties, address.property))
      )
        return { ok: false, reason: 'invalid' };
      return { ok: true, release, pin: 'pinned' };
    }
    if (address.type) {
      const result = await readType(address.type);
      if (!result.ok) return result;
      if (
        result.descriptor.typeId !== address.type ||
        (address.property &&
          (!result.descriptor.definition.properties.includes(address.property) ||
            !Object.hasOwn(result.descriptor.properties, address.property)))
      )
        return { ok: false, reason: 'invalid' };
      return { ok: true, descriptor: result.descriptor, pin: 'active' };
    }
    if (address.property) return { ok: false, reason: 'invalid' };
    const result = await readDirectory();
    return result.ok ? { ok: true, page: result.page, pin: 'active' } : result;
  } catch (error) {
    return { ok: false, reason: failure(error) };
  }
}

/** UI language fallback is explicit; authored value languages are never changed by this guide. */
export function definitionText(values: Record<string, string> | undefined, locale: string) {
  return pickText(values ?? {}, locale);
}

export const guideTypes = createTypes;

/** Only the existing catalogue creation and canonical subject editors can be return destinations. */
export function guideReturnTo(value: unknown, locale: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\r\n]/.test(value)) return;
  const prefix = `/${locale}`;
  if (!value.startsWith(`${prefix}/`)) return;
  const url = new URL(value, 'https://guide.invalid');
  if (url.origin !== 'https://guide.invalid') return;
  const path = url.pathname.slice(prefix.length);
  if (path === '/catalogue/new' || /^\/subjects\/[0-9a-f-]{36}\/[^/]+\/(?:edit|relation-edit)$/.test(path))
    return `${url.pathname}${url.search}${url.hash}`;
}

export function definitionGuideHref(locale: string, address: GuideAddress = {}): string {
  const query = new URLSearchParams();
  for (const key of ['type', 'property', 'release'] as const) if (address[key]) query.set(key, address[key]);
  const returnTo = guideReturnTo(address.returnTo, locale);
  if (returnTo) query.set('returnTo', returnTo);
  return `/${locale}/catalogue/definitions${query.size ? `?${query}` : ''}`;
}
