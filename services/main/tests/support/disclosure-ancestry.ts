import { createHash } from 'node:crypto';
import {
  configureDisclosureAncestrySource,
  type DisclosureAncestryEvidence,
  type DisclosureReader,
  type DisclosureTarget,
  type OwnerEstablishedGraphParent,
} from '../../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../../src/modules/work/activate.ts';

export const fixtureDisclosureCut = { recoveryGeneration: '0', enforcementCut: 'a'.repeat(64) };

/** Test owners declare their exact Work relationship or an independent
 * publication. Production sources must establish those facts in owner storage. */
export function configureFixtureDisclosureAncestry(env: WorkActivationEnvironment,
  parentFor: (target: DisclosureTarget) => Omit<OwnerEstablishedGraphParent,
    'owner' | 'kind' | 'relationshipBasis'> | undefined): void {
  const selected = new Map<string, DisclosureTarget>();
  const evidence = (target: DisclosureTarget): DisclosureAncestryEvidence => {
    const parent = parentFor(target);
    const relationshipBasis = {
      owner: target.owner === 'media' ? 'media' as const : target.owner === 'content' ? 'content' as const : 'graph' as const,
      kind: parent ? 'work-ownership' as const : 'publication' as const,
      resource: target.resource,
      revision: target.revision ?? 'fixture:publication:1',
      targetResource: target.resource,
      targetRevision: target.revision ?? null,
      token: createHash('sha256').update(JSON.stringify([target, parent])).digest('hex'),
      dataEpoch: env.lineage.dataEpoch,
    };
    selected.set(relationshipBasis.token, target);
    return { resource: target.resource, resourceKind: 'other', relationshipBasis,
      parents: parent ? [{ ...parent, owner: 'graph', kind: 'work', relationshipBasis }] : [], status: 'complete' };
  };
  for (const owner of ['graph', 'content', 'media', 'review', 'discovery'] as const)
    configureDisclosureAncestrySource(env, owner, {
      read: async targets => targets.map(evidence),
      reread: async bases => bases.map(basis => evidence(selected.get(basis.token)!)),
    });
}

/** A declared fixture cut preserves audience and paired-name behavior for
 * injected policy readers; no default production reader is installed. */
export function fixtureDisclosureReader(read: DisclosureReader['read']): DisclosureReader {
  return { read, readAtCut: async (targets, viewer, channel, client, anonymousNames) => ({
    decisions: await read(targets, viewer, channel, client),
    anonymousNames: anonymousNames ? targets.map(() => 'visible') : [],
    fenceBasis: fixtureDisclosureCut,
  }) };
}
