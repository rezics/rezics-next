import type { ContentCore, ExactReadResult } from '../../../../content/src/core.ts';
import { isDeepStrictEqual } from 'node:util';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../media/store.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { captureDisclosure, configureDisclosure, fenceDisclosure, resolveDisclosureSelections,
  DisclosureUnavailable, type DisclosureChannel,
  type DisclosureTarget } from './read.ts';
import { currentDisclosureViewer } from './viewer.ts';
import { configureMediaVisibility, isNativeAssetOwner } from '../media/visibility.ts';
import { graphErasedContentRevisions } from '../erasure/graph.ts';

/** Keep the owner-selected occurrence fixed across hydration and the final
 * policy check. Sources establish ancestry; request context is only a hint.
 * Disclosure receives the complete inventory and owns its bound and batching. */
async function finalDisclosure<T>(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel, hydrate: () => Promise<T>) {
  const selections = await resolveDisclosureSelections(env, targets);
  const cuts = await captureDisclosure(env, selections, viewer, channel);
  const value = await hydrate();
  const decisions = await fenceDisclosure(env, cuts, viewer, channel);
  return { value, decisions };
}

/** Delivery may first locate a mutable slot to select its exact asset/use.
 * Reread that same owner selection after capture so newer provenance cannot
 * authorize the bytes obtained from its predecessor. */
function rereadDelivery<T>(selected: T, read: () => Promise<T>): () => Promise<T> {
  const basis = structuredClone(selected);
  return async () => {
    const fresh = await read();
    if (!isDeepStrictEqual(basis, fresh)) throw new DisclosureUnavailable('Media delivery selection moved');
    return fresh;
  };
}

export async function discloseContent(env: WorkActivationEnvironment, results: readonly ExactReadResult[],
  viewer: Viewer = ANONYMOUS_VIEWER, channel: DisclosureChannel = 'read'): Promise<ExactReadResult[]> {
  const available = results.filter(result => result.status === 'available');
  if (!available.length) return [...results];
  const { value: erased, decisions } = await finalDisclosure(env, available.map(result => ({ owner: 'content' as const,
    resource: result.reference.resourceId, component: 'body' as const, revision: result.revisionId,
  })), viewer, channel, () => graphErasedContentRevisions(env.fuseki, available.map(result => result.revisionId)));
  const denied = new Set(available.filter((_, index) => decisions[index] !== 'visible').map(result => result.revisionId));
  return results.map(result => erased.has(result.revisionId)
    ? { revisionId: result.revisionId, status: 'erased' } : denied.has(result.revisionId)
    ? { revisionId: result.revisionId, status: 'denied' } : result);
}

/** Main's public read adapter; the original owner remains available to admitted
 * commands, evidence capture and projection recovery. No stored body is redacted in place. */
const contentDisclosureEnvironments = new WeakMap<object, WorkActivationEnvironment>();

export function disclosureContent<T extends Pick<ContentCore, 'readExactBatch'>>(content: T,
  env: WorkActivationEnvironment): T {
  if (contentDisclosureEnvironments.get(content) === env) return content;
  const proxy = new Proxy(content, { get(target, property) {
    if (property === 'readExactBatch') return async (...args: Parameters<ContentCore['readExactBatch']>) =>
      discloseContent(env, await target.readExactBatch(...args), currentDisclosureViewer());
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  contentDisclosureEnvironments.set(proxy, env);
  return proxy;
}

/** Asset state remains the media owner's responsibility. This adapter adds the
 * shared audience gate before either public avatars or private asset delivery. */
export function disclosureMedia(store: MediaStore, env: WorkActivationEnvironment): MediaStore {
  const itemTargets = (use: string, row: NonNullable<Awaited<ReturnType<MediaStore['itemDelivery']>>>): DisclosureTarget[] => {
    const context = row.context ?? undefined;
    const occurrence = { owner: 'media' as const, kind: 'media-use' as const,
      resource: `https://rezics.com/id/${use}`, revision: `https://rezics.com/id/${use}` };
    return [
      { owner: 'media', resource: `https://rezics.com/id/${row.asset}`, component: 'cover', context, occurrence },
      { owner: 'media', resource: `https://rezics.com/id/${use}`, component: 'media_use', context, occurrence },
      { owner: 'media', resource: row.target, component: 'media_use', context, occurrence },
      { owner: 'graph', resource: row.target, component: 'name', context },
    ];
  };
  return new Proxy(store, { get(target, property) {
    if (property === 'avatarDelivery') return async (...args: Parameters<MediaStore['avatarDelivery']>) => {
      const row = await target.avatarDelivery(...args);
      if (!row?.asset) return null;
      const viewer = currentDisclosureViewer();
      const context = row.context ?? undefined;
      const occurrence = row.use ? { owner: 'media' as const, kind: 'media-use' as const,
        resource: `https://rezics.com/id/${row.use}`, revision: `https://rezics.com/id/${row.use}` } : undefined;
      const { decisions } = await finalDisclosure(env, [
        { owner: 'media', resource: `https://rezics.com/id/${args[0]}`, component: 'media_use', context },
        { owner: 'media', resource: `https://rezics.com/id/${row.asset}`, component: 'cover', context, occurrence },
        ...(row.use ? [{ owner: 'media' as const, resource: `https://rezics.com/id/${row.use}`,
          component: 'media_use' as const, context, occurrence }] : []),
        { owner: 'graph', resource: row.target, component: 'name', context },
      ], viewer, 'media', rereadDelivery(row, () => target.avatarDelivery(...args)));
      return decisions.every(decision => decision === 'visible') ? row : null;
    };
    if (property === 'itemDelivery') return async (...args: Parameters<MediaStore['itemDelivery']>) => {
      const row = await target.itemDelivery(...args);
      if (!row) return null;
      const viewer = currentDisclosureViewer();
      const { decisions } = await finalDisclosure(env, itemTargets(args[0], row), viewer, 'media',
        rereadDelivery(row, () => target.itemDelivery(...args)));
      return decisions.every(decision => decision === 'visible') ? row : null;
    };
    if (property === 'itemDeliveryBatch') return async (...args: Parameters<MediaStore['itemDeliveryBatch']>) => {
      const rows = await target.itemDeliveryBatch(...args);
      if (!rows.size) return rows;
      const entries = [...rows];
      const viewer = currentDisclosureViewer();
      const targets = entries.flatMap(([use, row]) => itemTargets(use, row));
      const { decisions } = await finalDisclosure(env, targets, viewer, 'media',
        rereadDelivery(rows, () => target.itemDeliveryBatch(...args)));
      return new Map(entries.filter((_, index) => decisions.slice(index * 4, index * 4 + 4)
        .every(decision => decision === 'visible')));
    };
    if (property === 'assetDelivery') return async (...args: Parameters<MediaStore['assetDelivery']>) => {
      const row = await target.assetDelivery(...args);
      if (!row) return null;
      const viewer = currentDisclosureViewer();
      const nativeOwner = isNativeAssetOwner(viewer, `https://rezics.com/id/${args[0]}`, row.owner);
      const context = nativeOwner ? undefined : args[2] ?? DEFAULT_MEDIA_CONTEXT;
      const { decisions } = await finalDisclosure(env, [
        { owner: 'media', resource: `https://rezics.com/id/${args[0]}`, component: 'cover', context },
        ...nativeOwner ? []
          : [{ owner: 'graph' as const, resource: args[1], component: 'name' as const, context }],
      ], viewer, 'media', rereadDelivery(row, () => target.assetDelivery(...args)));
      return decisions.every(decision => decision === 'visible') ? row : null;
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Every composed public reader requires configured disclosure and ancestry
 * owners. Missing owners remain unavailable through the shared reader contract. */
export function composeDisclosure(deps: MainWorkDependencies): void {
  if (!deps.environment) return;
  configureMediaVisibility(deps);
  configureDisclosure(deps.environment, deps.governance
    ? deps.governance.store.disclosure ?? { read: async () => { throw new DisclosureUnavailable('Disclosure owner is unavailable'); } }
    : null);
  if (deps.content) deps.content = disclosureContent(deps.content, deps.environment);
  if (deps.media) deps.media = { ...deps.media, store: disclosureMedia(deps.media.store, deps.environment) };
}
