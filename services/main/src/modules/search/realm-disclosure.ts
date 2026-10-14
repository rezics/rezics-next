import { discloseInventory, hasDisclosure } from '../disclosure/read.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import { readRealmPolicy } from '../space/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { PublicQueryUnavailable, PublicRealmUnavailable } from '../work/search-public.ts';

/** Realm scope is itself a disclosed record. Work disclosure cannot establish
 * it: independently published originals survive closure of their adopting Realm.
 * Recheck after every owner has hydrated the answer, including empty pages. */
export async function withPublicRealmSearch<T>(env: WorkActivationEnvironment, realm: string | undefined,
  read: () => Promise<T>): Promise<T> {
  if (!realm) return read();
  const policy = await readRealmPolicy(env, realm);
  if (!policy || policy.visibility === 'private') throw new PublicRealmUnavailable('Realm is unavailable');
  if (!policy.realmRevision || !hasDisclosure(env)) throw new PublicQueryUnavailable('Realm disclosure is unavailable');
  const assertVisible = async () => {
    const decisions = await discloseInventory(env, [{ owner: 'graph', resource: realm,
      component: 'record', revision: policy.realmRevision }], currentDisclosureViewer(), 'search');
    if (decisions[0] !== 'visible') throw new PublicRealmUnavailable('Realm is unavailable');
  };
  await assertVisible();
  const result = await read();
  await assertVisible();
  return result;
}
