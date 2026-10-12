import type { UiLocale } from '../../i18n/define.ts';
import { parseAddressSegment, targetKey } from '../address/path.ts';
import { isUuid, type Loaded, type ReadFailure } from '../manage/types.ts';
import type { SiteResolution } from '../realm/read.ts';
import { readZoneLifecycleSnapshot } from './lifecycle.ts';

export interface ZoneManagementBinding {
  zoneId: string;
  spaceId: string;
  revision: string;
  configuration: Record<string, unknown>;
  status: 'active' | 'retired';
  name: string | null;
}

export type ZoneManagementAddress =
  | { kind: 'site'; site: Extract<SiteResolution, { kind: 'site' }>; binding: ZoneManagementBinding | null }
  | { kind: 'lifecycle'; binding: ZoneManagementBinding }
  | { kind: 'missing' }
  | { kind: 'failure'; failure: ReadFailure };

const nativeIri = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

/** The authorized configuration owns the Zone→Space relation, including after retirement. */
export function zoneManagementBinding(zoneId: string, value: unknown): ZoneManagementBinding | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { revision?: unknown; configuration?: unknown; name?: unknown };
  const snapshot = readZoneLifecycleSnapshot(row.revision, row.configuration);
  if (!snapshot || !row.configuration || typeof row.configuration !== 'object') return null;
  const configuration = row.configuration as Record<string, unknown>;
  const spaceId = typeof configuration.space === 'string' ? nativeIri.exec(configuration.space)?.[1] : undefined;
  if (configuration.zone !== `https://rezics.com/id/${zoneId}` || !spaceId) return null;
  return { zoneId, spaceId, revision: snapshot.revision, status: snapshot.status, configuration,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : null };
}

/** A UUID can name either resource. Read a Zone binding before resolving a Space identity. */
export async function resolveZoneManagementAddress(space: string, locale: UiLocale, read: {
  configuration: (zoneId: string) => Promise<Loaded<unknown>>;
  site: (space: string, locale: UiLocale) => Promise<SiteResolution>;
}): Promise<ZoneManagementAddress> {
  let binding: ZoneManagementBinding | null = null;
  let spaceAddress = space;
  if (isUuid(space)) {
    const configuration = await read.configuration(space);
    if (configuration.ok) {
      binding = zoneManagementBinding(space, configuration.data);
      if (!binding) return { kind: 'failure', failure: 'unavailable' };
      if (binding.status === 'retired') return { kind: 'lifecycle', binding };
      spaceAddress = binding.spaceId;
    } else if (configuration.failure !== 'denied' && configuration.failure !== 'missing') {
      return { kind: 'failure', failure: configuration.failure };
    }
  }
  const site = await read.site(spaceAddress, locale);
  if (site.kind === 'missing' || site.kind === 'join') return { kind: 'missing' };
  if (site.kind !== 'site') return { kind: 'failure', failure: managementAddressFailure(site.failure) };
  if (binding && (site.zone !== binding.zoneId || site.address.holder !== `https://rezics.com/id/${binding.spaceId}`)) {
    return { kind: 'failure', failure: 'unavailable' };
  }
  return { kind: 'site', site, binding };
}

/** Keep only a return address admitted for this binding; its native Space address is always recoverable. */
export function zoneManagementReturnAddress(candidate: unknown, binding: Pick<ZoneManagementBinding, 'zoneId' | 'spaceId'>,
  admitted?: { address: string; space: string },
): string {
  const parsed = typeof candidate === 'string' ? parseAddressSegment(candidate) : null;
  if (parsed && (parsed.kind === 'alias'
    ? admitted !== undefined && admitted.address === candidate && admitted.space === `https://rezics.com/id/${binding.spaceId}`
    : parsed.id === binding.spaceId || parsed.id === binding.zoneId)) return candidate as string;
  return targetKey(binding.spaceId);
}

function managementAddressFailure(failure: Extract<SiteResolution, { kind: 'unavailable' }>['failure']): ReadFailure {
  if (failure === 'missing' || failure === 'moved' || failure === 'invalid' || failure === 'budget') return failure;
  return 'unavailable';
}
