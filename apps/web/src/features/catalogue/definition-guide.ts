import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { createTypes } from './create-subject';

export type GuideRelease = Pick<Release, 'types' | 'properties'> & { digest: string };
export type GuideAddress = { type?: string; property?: string; release?: string; returnTo?: string };
export type GuideFailure = 'denied' | 'concealed' | 'invalid' | 'unavailable';
export type GuideRead =
  | { ok: false; reason: GuideFailure }
  | { ok: true; release: GuideRelease; pin: 'active' | 'pinned' };
export type GuideTransport = { read: () => Promise<GuideRead> };

export class DefinitionReadError extends Error {
  constructor(public readonly reason: GuideFailure) {
    super(`Definitions ${reason}`);
  }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;
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

export async function readGuide(
  address: GuideAddress,
  read: (digest?: string) => Promise<GuideRelease>,
): Promise<GuideRead> {
  try {
    if (address.release !== undefined && !digestPattern.test(address.release)) return { ok: false, reason: 'invalid' };
    const release = await read(address.release);
    if (address.type && !Object.hasOwn(release.types, address.type)) return { ok: false, reason: 'invalid' };
    if (
      address.property &&
      (!address.type ||
        !release.types[address.type]?.properties.includes(address.property) ||
        !Object.hasOwn(release.properties, address.property))
    )
      return { ok: false, reason: 'invalid' };
    return { ok: true, release, pin: address.release === undefined ? 'active' : 'pinned' };
  } catch (error) {
    return { ok: false, reason: error instanceof DefinitionReadError ? error.reason : 'unavailable' };
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
