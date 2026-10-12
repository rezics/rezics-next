import { cache } from 'react';
import type { ZoneText } from '@rezics/zone-sdk';
import { addressKey, parseAddressSegment, spaceHref } from '../address/path.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { settle } from '../manage/read.ts';
import { type MainClient, type ReadFailure } from '../manage/types.ts';
import { resolveSite, type SiteResolution } from '../realm/read.ts';
import { authoringModel, type ZoneAuthoringModel } from './model.ts';
import { resolveZoneManagementAddress, zoneManagementBinding, zoneManagementReturnAddress,
  type ZoneManagementBinding } from './management-address.ts';
import { zoneEditorPath, zonePreviewPath } from './routes.ts';

type EditorRead = NonNullable<Awaited<ReturnType<ReturnType<MainClient['v1']['zones']>['showcase-editor']['get']>>['data']>;
export type ZoneAuthoringPreview = EditorRead['preview'];

export type ZoneAuthoringLoad =
  | { kind: 'missing' }
  | { kind: 'failure'; failure: ReadFailure }
  | { kind: 'ready'; model: ZoneAuthoringModel; preview: ZoneAuthoringPreview; realm: string | null;
    frameMetadata: { ref: string; name: ZoneText };
    editorPath: string; previewPath: string; sitePath: string };

export type ZoneLifecycleLoad =
  | { kind: 'missing' }
  | { kind: 'failure'; failure: ReadFailure }
  | { kind: 'ready'; zoneId: string; spaceId: string; revision: string; status: 'active' | 'retired'; name: string;
    returnAddress: string };

/** Recovery can outlive a cached retired address. Revalidate with the same admission owner. */
export async function readZoneAuthoringSite(space: string, locale: UiLocale,
  resolve = resolveSite,
): Promise<SiteResolution> {
  const site = await resolve(space, locale);
  return site.kind === 'missing' ? resolve(space, locale, true) : site;
}

export const resolveZoneAuthoringSite = cache(readZoneAuthoringSite);

const resolveManagementAddress = cache((main: MainClient, space: string, locale: UiLocale, actingSubject: string) =>
  resolveZoneManagementAddress(space, locale, {
    configuration: zoneId => settle(() => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } }),
      { management: true }),
    site: resolveZoneAuthoringSite,
  }));

/**
 * The home draft and the two heads a publish names. Shared by the editor and its preview
 * for one request. An editor who cannot read the draft is refused here, never shown the public page.
 */
export const loadZoneAuthoring = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneAuthoringLoad> => {
  const address = await resolveManagementAddress(main, space, locale, actingSubject);
  if (address.kind === 'missing' || address.kind === 'lifecycle') return { kind: 'missing' };
  if (address.kind === 'failure') return address;
  const { site } = address;
  const [editor, zone] = await Promise.all([
    settle(() => main.v1.zones({ id: site.zone })['showcase-editor'].get({ query: { actingSubject } }), { management: true }),
    settle(() => main.v1.zones({ id: site.zone }).get({ query: { actingSubject } }), { management: true }),
  ]);
  if (!editor.ok) return { kind: 'failure', failure: editor.failure };
  if (!zone.ok) return { kind: 'failure', failure: zone.failure };
  const suffix = site.address.canonical.suffixSource?.trim();
  const model = authoringModel(editor.data, zone.data, site.zone, suffix || addressKey(site.address.canonical) || space);
  if (!model) return { kind: 'failure', failure: 'unavailable' };
  return {
    kind: 'ready', model, preview: editor.data.preview,
    realm: typeof editor.data.configuration.defaultRealm === 'string' ? editor.data.configuration.defaultRealm : null,
    frameMetadata: { ref: addressKey(site.address.canonical),
      name: { value: model.name, lang: editor.data.language, dir: editor.data.direction } },
    editorPath: zoneEditorPath(space),
    previewPath: zonePreviewPath(space),
    sitePath: spaceHref(site.address.canonical, 'site'),
  };
});

/**
 * Authorized lifecycle entry. A retired site's public Space resolver no longer
 * yields its Zone capability, so the stable Zone UUID is also a management key.
 */
export const loadZoneLifecycle = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneLifecycleLoad> => {
  const address = await resolveManagementAddress(main, space, locale, actingSubject);
  if (address.kind === 'missing' || address.kind === 'failure') return address;
  let binding = address.binding;
  if (!binding && address.kind === 'site') {
    const loaded = await settle(() => main.v1.zones({ id: address.site.zone }).configuration.get({ query: { actingSubject } }),
      { management: true });
    if (!loaded.ok) return { kind: 'failure', failure: loaded.failure };
    binding = zoneManagementBinding(address.site.zone, loaded.data);
  }
  if (!binding) return { kind: 'failure', failure: 'unavailable' };
  return { kind: 'ready', zoneId: binding.zoneId, spaceId: binding.spaceId, revision: binding.revision,
    status: binding.status, name: binding.name ?? space,
    returnAddress: zoneManagementReturnAddress(space, binding, address.kind === 'site'
      ? { address: space, space: address.site.address.holder } : undefined) };
});

/** Validate aliases with the address owner; a retired or unavailable alias falls back to the bound Space. */
export async function loadZoneRecoveryReturnAddress(main: MainClient, candidate: unknown,
  binding: Pick<ZoneManagementBinding, 'zoneId' | 'spaceId'>, actingSubject: string,
): Promise<string> {
  const fallback = zoneManagementReturnAddress(candidate, binding);
  if (typeof candidate !== 'string' || candidate === fallback) return fallback;
  const parsed = parseAddressSegment(candidate);
  if (parsed?.kind !== 'alias') return fallback;
  const admitted = await settle(() => main.v1.addresses.resolve.get({ query: {
    scope: 'space', key: candidate, actingSubject,
  } }));
  return zoneManagementReturnAddress(candidate, binding, admitted.ok && admitted.data.status === 'resolved'
    ? { address: candidate, space: admitted.data.holder } : undefined);
}
