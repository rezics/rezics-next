import type { ZoneText } from '@rezics/zone-sdk';
import type { ResolvedAddress } from '../address/client.ts';
import { addressKey, parseAddressSegment, spaceHref, targetKey } from '../address/path.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { settle } from '../manage/read.ts';
import type { MainClient, ReadFailure } from '../manage/types.ts';
import { idOf } from '../realm/route.ts';
import type { SiteResolution } from '../realm/read.ts';
import { authoringModel, type ZoneAuthoringModel } from './model.ts';
import { resolveZoneManagementAddress, zoneManagementBinding, zoneManagementReturnAddress,
  type ZoneManagementAddress, type ZoneManagementBinding } from './management-address.ts';
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

const nativeIri = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type SuppliedAddressAnswer = {
  data: unknown;
  error: { status: number; value?: unknown } | null;
  response?: unknown;
};

function replayGap(error: unknown): boolean {
  return error instanceof Error
    && /Unmatched recorded request|Ambiguous recorded request|Recorded sample|cannot supply/.test(error.message);
}

/**
 * The address profile a management read can admit. The server resolver owns the same grammar;
 * this copy stays with the browser reader, which cannot load that server module.
 */
function admittedAddress(value: unknown): ResolvedAddress | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as ResolvedAddress;
  const address = data.canonical;
  const chapterPlace = address && /^\/w\/[^/]+\/read\/$/.test(address.prefix);
  if (
    data.profile !== 'address-resolution-v1' ||
    data.status !== 'resolved' ||
    typeof data.scope !== 'string' ||
    !/^(?:agent|space|work|resource|concept|zone:https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
      data.scope,
    ) ||
    typeof data.key !== 'string' ||
    !['current', 'redirect'].includes(data.state) ||
    !nativeIri.test(data.holder) ||
    !address ||
    typeof address.key !== 'string' ||
    !parseAddressSegment(address.key) ||
    (parseAddressSegment(address.key)?.kind === 'uuid' && !chapterPlace) ||
    typeof address.suffixSource !== 'string' ||
    !/^\/(?:@|(?:a|r|z|w|e|concepts)\/|z\/[^/]+\/[^/]+\/|w\/[^/]+\/(?:read\/)?)$/.test(address.prefix) ||
    (data.capabilities && Object.values(data.capabilities).some(item => typeof item !== 'string' || !nativeIri.test(item)))
  ) return null;
  return data;
}

/** Site resolution for a caller that already holds the typed client and the acting person. */
async function resolveSuppliedSite(
  read: (key: string, actingSubject: string) => Promise<SuppliedAddressAnswer>,
  ref: string,
  actingSubject: string,
): Promise<SiteResolution> {
  try {
    const answer = await read(ref, actingSubject);
    if (answer.error) {
      if (!answer.response && answer.error.value instanceof Error) throw answer.error.value;
      const status = answer.error.status;
      if (status === 400 || status === 404 || status === 422 || status === 410) return { kind: 'missing' };
      return { kind: 'unavailable' };
    }
    const data = admittedAddress(answer.data);
    if (!data || data.scope !== 'space') return { kind: 'unavailable' };
    const zone = idOf(data.capabilities?.zone ?? '');
    if (!zone) return { kind: 'missing' };
    return { kind: 'site', address: data, zone, realm: idOf(data.capabilities?.realm ?? '') };
  } catch (error) {
    if (replayGap(error)) throw error;
    return { kind: 'unavailable' };
  }
}

/** The bound Space, read as the same acting person as the configuration. A missing answer is read once more. */
export function suppliedManagementSite(main: MainClient, actingSubject: string) {
  const read = (key: string, subject: string) => main.v1.addresses.resolve.get({
    query: { scope: 'space' as const, key, actingSubject: subject },
  });
  return async (ref: string, _locale: UiLocale): Promise<SiteResolution> => {
    const site = await resolveSuppliedSite(read, ref, actingSubject);
    return site.kind === 'missing' ? resolveSuppliedSite(read, ref, actingSubject) : site;
  };
}

/** Configuration first. Denial or absence is not admission, so the original key is still resolved. */
export function readManagementAddress(main: MainClient, space: string, locale: UiLocale, actingSubject: string,
  site: (space: string, locale: UiLocale) => Promise<SiteResolution>,
): Promise<ZoneManagementAddress> {
  return resolveZoneManagementAddress(space, locale, {
    configuration: zoneId => settle(() => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } }),
      { management: true }),
    site,
  });
}

/** The editor and the Zone, after the management address has been admitted. */
export async function zoneAuthoringFromAddress(main: MainClient, space: string, actingSubject: string,
  address: ZoneManagementAddress,
): Promise<ZoneAuthoringLoad> {
  if (address.kind === 'missing') return { kind: 'missing' };
  if (address.kind === 'failure') return address;
  // A retired Zone retains its authorized binding and draft; public admission is no longer available.
  const site = address.kind === 'site' ? address.site : null;
  const zoneId = site?.zone ?? (address.kind === 'lifecycle' ? address.binding.zoneId : '');
  const ref = site ? addressKey(site.address.canonical) : targetKey(address.kind === 'lifecycle' ? address.binding.spaceId : '');
  const [editor, zone] = await Promise.all([
    settle(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }), { management: true }),
    settle(() => main.v1.zones({ id: zoneId }).get({ query: { actingSubject } }), { management: true }),
  ]);
  if (!editor.ok) return { kind: 'failure', failure: editor.failure };
  if (!zone.ok) return { kind: 'failure', failure: zone.failure };
  if (typeof editor.data.preview?.navigation?.revision !== 'string') return { kind: 'failure', failure: 'unavailable' };
  const suffix = site?.address.canonical.suffixSource?.trim();
  const model = authoringModel(editor.data, zone.data, zoneId, suffix || ref || space);
  if (!model) return { kind: 'failure', failure: 'unavailable' };
  return {
    kind: 'ready', model, preview: editor.data.preview,
    realm: typeof editor.data.configuration.defaultRealm === 'string' ? editor.data.configuration.defaultRealm : null,
    frameMetadata: { ref,
      name: { value: model.name, lang: editor.data.language, dir: editor.data.direction } },
    editorPath: zoneEditorPath(space),
    previewPath: zonePreviewPath(space),
    sitePath: spaceHref(site?.address.canonical ?? ref, 'site'),
  };
}

/**
 * The home draft and the two heads a publish names. The request-cached host wrapper and a
 * recorded visit call this. An editor who cannot read the draft is refused here.
 */
export async function readZoneAuthoring(main: MainClient, space: string, locale: UiLocale, actingSubject: string,
  site: (space: string, locale: UiLocale) => Promise<SiteResolution> = suppliedManagementSite(main, actingSubject),
): Promise<ZoneAuthoringLoad> {
  return zoneAuthoringFromAddress(main, space, actingSubject,
    await readManagementAddress(main, space, locale, actingSubject, site));
}

/** Authorized lifecycle entry from the same management address as the editor. */
export async function zoneLifecycleFromAddress(main: MainClient, space: string, actingSubject: string,
  address: ZoneManagementAddress,
): Promise<ZoneLifecycleLoad> {
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
}

export async function readZoneLifecycle(main: MainClient, space: string, locale: UiLocale, actingSubject: string,
  site: (space: string, locale: UiLocale) => Promise<SiteResolution> = suppliedManagementSite(main, actingSubject),
): Promise<ZoneLifecycleLoad> {
  return zoneLifecycleFromAddress(main, space, actingSubject,
    await readManagementAddress(main, space, locale, actingSubject, site));
}

/** Validate aliases with the address owner; a retired or unavailable alias falls back to the bound Space. */
export async function readZoneRecoveryReturnAddress(main: MainClient, candidate: unknown,
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

/** What the management layout shows, and whether the draft provider may admit the Zone. */
export interface ZoneManagementFrame {
  missing: boolean;
  name: string;
  lifecycleOnly: boolean;
  lifecycleAddress?: { zoneId: string; spaceId: string; returnAddress: string };
  draftZoneId: string | null;
  authoring: ZoneAuthoringLoad;
  lifecycle: ZoneLifecycleLoad;
}

/**
 * The editor name wins. A lifecycle name is the fallback, then the address the visit used.
 * A retired lifecycle hides the content sections. Either ready read can admit the draft provider.
 */
export function zoneManagementFrame(space: string, authoring: ZoneAuthoringLoad, lifecycle: ZoneLifecycleLoad,
  returnAddress?: string,
): ZoneManagementFrame {
  const readyEditor = authoring.kind === 'ready' ? authoring : null;
  const readyLifecycle = lifecycle.kind === 'ready' ? lifecycle : null;
  return {
    missing: authoring.kind === 'missing' && lifecycle.kind === 'missing',
    name: readyEditor?.model.name ?? readyLifecycle?.name ?? space,
    lifecycleOnly: readyLifecycle?.status === 'retired',
    lifecycleAddress: readyLifecycle ? {
      zoneId: readyLifecycle.zoneId, spaceId: readyLifecycle.spaceId,
      returnAddress: returnAddress ?? readyLifecycle.returnAddress,
    } : undefined,
    draftZoneId: readyEditor?.model.zoneId ?? readyLifecycle?.zoneId ?? null,
    authoring, lifecycle,
  };
}

/** Apply a requested return address only when the lifecycle read admits one. */
export async function zoneManagementFrameFromReads(main: MainClient, space: string, actingSubject: string,
  authoring: ZoneAuthoringLoad, lifecycle: ZoneLifecycleLoad, returnCandidate: string | null,
): Promise<ZoneManagementFrame> {
  const returnAddress = lifecycle.kind === 'ready' && returnCandidate
    ? await readZoneRecoveryReturnAddress(main, returnCandidate, lifecycle, actingSubject) : undefined;
  return zoneManagementFrame(space, authoring, lifecycle, returnAddress);
}

/**
 * One management address, then the editor and the lifecycle together.
 * A denied configuration still resolves the Space, and the lifecycle read asks for configuration again.
 */
export async function readZoneManagementFrame(main: MainClient, space: string, locale: UiLocale, actingSubject: string,
  site: (space: string, locale: UiLocale) => Promise<SiteResolution> = suppliedManagementSite(main, actingSubject),
  returnCandidate: string | null = null,
): Promise<ZoneManagementFrame> {
  const address = await readManagementAddress(main, space, locale, actingSubject, site);
  const [authoring, lifecycle] = await Promise.all([
    zoneAuthoringFromAddress(main, space, actingSubject, address),
    zoneLifecycleFromAddress(main, space, actingSubject, address),
  ]);
  return zoneManagementFrameFromReads(main, space, actingSubject, authoring, lifecycle, returnCandidate);
}
