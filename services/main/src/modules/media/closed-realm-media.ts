import { isDeepStrictEqual } from 'node:util';
import {
  captureDisclosure, fenceDisclosure, resolveDisclosureSelections, DisclosureUnavailable,
  type DisclosureTarget,
} from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

/** IDs come from the current Media owner read, including a rendition's owning
 * Asset and its exact Use when selected. A bare read deliberately has no Use:
 * the ancestry owner must establish its current attachment inventory. Neither
 * a requested target nor a requested Context establishes a parent. */
export interface ClosedRealmMediaReference {
  asset: string;
  representation?: string;
  use?: string | null;
  /** Current attachment Context from the owner; only a policy lookup hint. */
  context?: string;
}

export interface ClosedRealmMediaRead {
  /** Call after buffering bytes/metadata and before returning any response,
   * including an ETag-only 304. False has the route's ordinary absent result. */
  fence(): Promise<boolean>;
}

const nativeReference = (id: string) => id.startsWith('https://rezics.com/id/')
  ? id : `https://rezics.com/id/${id}`;

/** Uses the existing disclosure owner, including its fresh Access snapshot,
 * recovery fence and owner-established Work/Realm parents. It does not decide
 * closure or infer ancestry from HTTP input. Missing evidence is unavailable. */
export async function captureClosedRealmMedia(
  env: WorkActivationEnvironment,
  reference: ClosedRealmMediaReference,
  viewer: Viewer = ANONYMOUS_VIEWER,
): Promise<ClosedRealmMediaRead | null> {
  const occurrence = reference.use ? {
    owner: 'media' as const, kind: 'media-use' as const,
    resource: nativeReference(reference.use), revision: nativeReference(reference.use),
  } : undefined;
  const targets: DisclosureTarget[] = [
    { owner: 'media', resource: nativeReference(reference.asset), component: 'cover',
      context: reference.context, occurrence },
    ...(reference.representation ? [{ owner: 'media' as const,
      resource: nativeReference(reference.representation), component: 'cover' as const,
      context: reference.context, occurrence }] : []),
    ...(occurrence ? [{ owner: 'media' as const, resource: occurrence.resource,
      component: 'media_use' as const, context: reference.context, occurrence }] : []),
  ];
  const selections = await resolveDisclosureSelections(env, targets);
  const cuts = await captureDisclosure(env, selections, viewer, 'media');
  if (cuts.some(cut => cut.decision !== 'visible')) return null;
  return { fence: async () => (await fenceDisclosure(env, cuts, viewer, 'media'))
    .every(decision => decision === 'visible') };
}

/** Hydration must buffer its result: a callback must not start a download stream
 * or send headers before the final fence. An initially hidden read never loads
 * bytes or evaluates cache validators; a closure during hydration discards both. */
export async function readClosedRealmMedia<T>(
  env: WorkActivationEnvironment,
  reference: ClosedRealmMediaReference,
  hydrate: () => Promise<T>,
  viewer: Viewer = ANONYMOUS_VIEWER,
): Promise<T | null> {
  const read = await captureClosedRealmMedia(env, reference, viewer);
  if (!read) return null;
  const value = await hydrate();
  return await read.fence() ? value : null;
}

/** A route may need a first owner lookup to locate the Asset behind a mutable
 * selection. Capture its ancestry, then reread that exact owner basis before
 * hydration: a successor must not authorize bytes selected by its predecessor.
 * Hydrate the isolated captured basis: the shared reread can change again while
 * hydration awaits, but the final fence only covers that captured selection.
 * A missing owner row has the same null result as a hidden row. */
export async function readClosedRealmMediaSelection<Selection, Result>(
  env: WorkActivationEnvironment,
  readOwner: () => Promise<Selection | null>,
  referenceFor: (selection: Selection) => ClosedRealmMediaReference,
  hydrate: (selection: Selection) => Promise<Result>,
  viewer: Viewer = ANONYMOUS_VIEWER,
): Promise<Result | null> {
  const selected = await readOwner();
  if (selected === null) return null;
  const basis = structuredClone(selected);
  return readClosedRealmMedia(env, referenceFor(basis), async () => {
    const fresh = await readOwner();
    if (fresh === null || !isDeepStrictEqual(basis, fresh)) {
      throw new DisclosureUnavailable('Media delivery selection moved');
    }
    return hydrate(basis);
  }, viewer);
}
