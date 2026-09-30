import type { ContentCore, ExactReadResult } from '../../../../content/src/core.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { MediaStore } from '../media/store.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { configureDisclosure, discloseInventory, DisclosureUnavailable, type DisclosureChannel } from './read.ts';

export async function discloseContent(env: WorkActivationEnvironment, results: readonly ExactReadResult[],
  viewer: Viewer = ANONYMOUS_VIEWER, channel: DisclosureChannel = 'read'): Promise<ExactReadResult[]> {
  const available = results.filter(result => result.status === 'available');
  const decisions = await discloseInventory(env, available.map(result => ({ owner: 'content' as const,
    resource: result.reference.resourceId, component: 'body' as const, revision: result.revisionId,
    work: result.reference.resourceId })), viewer, channel);
  const denied = new Set(available.filter((_, index) => decisions[index] !== 'visible').map(result => result.revisionId));
  return results.map(result => denied.has(result.revisionId)
    ? { revisionId: result.revisionId, status: 'denied' } : result);
}

/** Main's public read adapter; the original owner remains available to admitted
 * commands, evidence capture and projection recovery. No stored body is redacted in place. */
export function disclosureContent<T extends Pick<ContentCore, 'readExactBatch'>>(content: T,
  env: WorkActivationEnvironment): T {
  return new Proxy(content, { get(target, property) {
    if (property === 'readExactBatch') return async (...args: Parameters<ContentCore['readExactBatch']>) =>
      discloseContent(env, await target.readExactBatch(...args));
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Asset state remains the media owner's responsibility. This adapter adds the
 * shared audience gate before either public avatars or private asset delivery. */
export function disclosureMedia(store: MediaStore, env: WorkActivationEnvironment): MediaStore {
  return new Proxy(store, { get(target, property) {
    if (property === 'avatarDelivery') return async (...args: Parameters<MediaStore['avatarDelivery']>) => {
      const row = await target.avatarDelivery(...args);
      if (!row?.asset) return null;
      const decisions = await discloseInventory(env, [
        { owner: 'media', resource: `https://rezics.com/id/${row.asset}`, component: 'cover' },
        ...(row.use ? [{ owner: 'media' as const, resource: `https://rezics.com/id/${row.use}`,
          component: 'media_use' as const }] : []),
        { owner: 'graph', resource: row.target, component: 'name', context: row.context ?? undefined },
      ], ANONYMOUS_VIEWER, 'media');
      return decisions.every(decision => decision === 'visible') ? row : null;
    };
    if (property === 'itemDelivery') return async (...args: Parameters<MediaStore['itemDelivery']>) => {
      const row = await target.itemDelivery(...args);
      if (!row) return null;
      const asset: unknown = Reflect.get(row, 'asset');
      const decisions = await discloseInventory(env, [
        ...(typeof asset === 'string' ? [{ owner: 'media' as const,
          resource: `https://rezics.com/id/${asset}`, component: 'cover' as const }] : []),
        { owner: 'media', resource: `https://rezics.com/id/${args[0]}`, component: 'media_use' },
        { owner: 'media', resource: row.target, component: 'media_use' },
        { owner: 'graph', resource: row.target, component: 'name' },
      ], ANONYMOUS_VIEWER, 'media');
      return decisions.every(decision => decision === 'visible') ? row : null;
    };
    if (property === 'assetDelivery') return async (...args: Parameters<MediaStore['assetDelivery']>) => {
      const row = await target.assetDelivery(...args);
      if (!row) return null;
      const decisions = await discloseInventory(env, [
        { owner: 'media', resource: `https://rezics.com/id/${args[0]}`, component: 'cover' },
        { owner: 'graph', resource: args[1], component: 'name', context: args[2] },
      ], ANONYMOUS_VIEWER, 'media');
      return decisions.every(decision => decision === 'visible') ? row : null;
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Missing governance preserves legacy fixtures; configured owner failures deny reads. */
export function composeDisclosure(deps: MainWorkDependencies): void {
  if (!deps.environment) return;
  configureDisclosure(deps.environment, deps.governance
    ? deps.governance.store.disclosure ?? { read: async () => { throw new DisclosureUnavailable('Disclosure owner is unavailable'); } }
    : null);
  if (deps.content) deps.content = disclosureContent(deps.content, deps.environment);
  if (deps.media) deps.media = { ...deps.media, store: disclosureMedia(deps.media.store, deps.environment) };
}
