import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { createTypes } from './create-subject';
import {
  comparisonField,
  guideCompareValue,
  type GuideComparison,
  type GuideComparisonSide,
} from './definition-guide-comparison';

export type GuideRelease = Pick<Release, 'types' | 'properties'> & { digest: string };
export type GuideLocale = 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant';
export type GuideAddress = {
  type?: string | undefined;
  property?: string | undefined;
  release?: string | undefined;
  returnTo?: string | undefined;
  compare?: typeof guideCompareValue | undefined;
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
  | { ok: true; descriptor: GuideTypeDescriptor; pin: 'active' }
  | { ok: true; comparison: GuideComparison; pin: 'compare' };
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
export function isGuideDigest(value: unknown): value is string {
  return typeof value === 'string' && digestPattern.test(value);
}
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

/** Active pointer only; never an exact historical file and never a substitute for a missing pin. */
export async function fetchGuideActiveDigest(
  client: KernelClient,
  headers: Record<string, string> = {},
): Promise<string> {
  const active = await client.definitions.active.get({ headers });
  requireSuccess(active.status);
  const selected = active.data?.digest;
  if (!isGuideDigest(selected)) throw new DefinitionReadError('invalid');
  return selected;
}

/** Generated native GETs, with current caller headers. Never cache a caller's authority or guess a release file. */
export async function fetchGuideRelease(
  client: KernelClient,
  digest?: string,
  headers: Record<string, string> = {},
): Promise<GuideRelease> {
  if (digest !== undefined && !isGuideDigest(digest)) throw new DefinitionReadError('invalid');
  const selected = digest ?? (await fetchGuideActiveDigest(client, headers));
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

function missingQualifierIds(descriptor: GuideTypeDescriptor): string[] {
  const missing = new Set<string>();
  for (const id of descriptor.definition.properties) {
    const property = descriptor.properties[id];
    if (!property) continue;
    for (const qualifier of property.qualifiers) {
      if (!Object.hasOwn(descriptor.properties, qualifier)) missing.add(qualifier);
    }
  }
  return [...missing];
}

/** Complete omitted qualifier definitions from this Type's digest; never the active pointer. */
async function completeGuideQualifiers(
  client: KernelClient,
  descriptor: GuideTypeDescriptor,
  headers: Record<string, string>,
): Promise<GuideTypeDescriptor> {
  const missing = missingQualifierIds(descriptor);
  if (missing.length === 0) return descriptor;
  let release: GuideRelease;
  try {
    release = await fetchGuideRelease(client, descriptor.releaseDigest, headers);
  } catch (error) {
    if (error instanceof DefinitionReadError) throw new DefinitionReadError('unavailable');
    throw error;
  }
  const properties = { ...descriptor.properties };
  for (const id of missing) {
    const definition = release.properties[id];
    if (!definition) throw new DefinitionReadError('unavailable');
    properties[id] = definition;
  }
  return { ...descriptor, properties };
}

/** Read one exact active Type descriptor; missing qualifiers come from that Type's digest. */
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
  return completeGuideQualifiers(client, response.data, headers);
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

async function readExactSide(
  readRelease: (digest?: string) => Promise<GuideRelease>,
  digest: string,
): Promise<GuideComparisonSide> {
  try {
    const release = await readRelease(digest);
    if (release.digest !== digest) return { status: 'invalid', digest };
    return { status: 'available', digest, release, admitted: false };
  } catch (error) {
    return { status: failure(error), digest };
  }
}

async function activeDigestFromRelease(readRelease: (digest?: string) => Promise<GuideRelease>) {
  return (await readRelease()).digest;
}

async function readComparedGuide(
  address: GuideAddress,
  readRelease: (digest?: string) => Promise<GuideRelease>,
  readActiveDigest: () => Promise<string>,
): Promise<GuideRead> {
  const typeId = address.type;
  const property = address.property;
  const pinnedDigest = address.release;
  if (!typeId || !property || !isGuideDigest(pinnedDigest)) return { ok: false, reason: 'invalid' };
  const withField = (side: GuideComparisonSide): GuideComparisonSide =>
    side.status === 'available' ? { ...side, ...comparisonField(side.release, typeId, property) } : side;
  const pinnedTask = readExactSide(readRelease, pinnedDigest);
  const currentTask = (async (): Promise<GuideComparisonSide> => {
    let digest: string;
    try {
      digest = await readActiveDigest();
    } catch (error) {
      return { status: failure(error) };
    }
    if (!isGuideDigest(digest)) return { status: 'invalid', digest };
    return readExactSide(readRelease, digest);
  })();
  const [pinned, current] = await Promise.all([pinnedTask, currentTask]);
  return {
    ok: true,
    pin: 'compare',
    comparison: { type: typeId, property, pinned: withField(pinned), current: withField(current) },
  };
}

export async function readGuide(
  address: GuideAddress,
  readRelease: (digest?: string) => Promise<GuideRelease>,
  readDirectory: () => Promise<GuidePageRead>,
  readType: (typeId: string) => Promise<GuideTypeRead>,
  readActiveDigest?: () => Promise<string>,
): Promise<GuideRead> {
  try {
    if (address.release !== undefined && !digestPattern.test(address.release)) return { ok: false, reason: 'invalid' };
    if (address.property && !address.type) return { ok: false, reason: 'invalid' };
    if (address.compare === guideCompareValue) {
      return readComparedGuide(address, readRelease, readActiveDigest ?? (() => activeDigestFromRelease(readRelease)));
    }
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

/** Compare is offered only for a pinned field opened from a validated editor return. */
export function guideEditorField(address: GuideAddress, locale: string) {
  return Boolean(
    address.type && address.property && isGuideDigest(address.release) && guideReturnTo(address.returnTo, locale),
  );
}

export function definitionGuideHref(locale: string, address: GuideAddress = {}): string {
  const query = new URLSearchParams();
  for (const key of ['type', 'property', 'release'] as const) if (address[key]) query.set(key, address[key]);
  if (address.compare === guideCompareValue && guideEditorField(address, locale))
    query.set('compare', guideCompareValue);
  const returnTo = guideReturnTo(address.returnTo, locale);
  if (returnTo) query.set('returnTo', returnTo);
  return `/${locale}/catalogue/definitions${query.size ? `?${query}` : ''}`;
}
