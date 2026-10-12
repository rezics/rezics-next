import { createHash } from 'node:crypto';
import { configureDisclosure, configureDisclosureAncestrySource,
  type DisclosureAncestryEvidence, type DisclosureRelationshipBasis, type DisclosureTarget,
  type DisclosureReader } from '../../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../../src/modules/work/activate.ts';
import { fixtureDisclosureReader } from './disclosure-ancestry.ts';

/** Explicit fixture evidence for selected campaign media. Each Asset/Use pair
 * shares the same immutable Use receipt; only mounted art receives a Realm. */
export function configureCampaignFixtureAncestry(env: WorkActivationEnvironment,
  realm?: { resource: string; head: string }) {
  const selected = new Map<string, DisclosureAncestryEvidence>();
  const evidence = (target: DisclosureTarget, use: string): DisclosureAncestryEvidence => {
    const relationshipBasis: DisclosureRelationshipBasis = {
      owner: 'media', kind: 'media-use', resource: use, revision: use,
      targetResource: target.resource, targetRevision: target.revision ?? null,
      token: createHash('sha256').update(JSON.stringify([use, realm])).digest('hex'),
      dataEpoch: env.lineage.dataEpoch,
    };
    const result: DisclosureAncestryEvidence = { resource: target.resource, resourceKind: 'other',
      relationshipBasis, status: 'complete', parents: realm ? [{ owner: 'graph', kind: 'realm',
        resource: realm.resource, head: realm.head, relationshipBasis: { ...relationshipBasis, kind: 'realm-placement' } }] : [] };
    selected.set(`${relationshipBasis.token}\0${target.resource}`, result);
    return result;
  };
  configureDisclosureAncestrySource(env, 'media', {
    read: async targets => targets.map((target, index) => evidence(target,
      target.occurrence?.resource ?? (target.component === 'cover' ? targets[index + 1]!.resource : target.resource))),
    reread: async bases => bases.map(basis => selected.get(`${basis.token}\0${basis.targetResource}`)!),
  });
}

export function campaignFixtureEnvironment(realm?: { resource: string; head: string }): WorkActivationEnvironment {
  const env = { objectDirectory: '.temp/campaign-disclosure',
    lineage: { dataEpoch: 'campaign-fixture', routingEpoch: 'campaign-routing' },
    fuseki: { query: async () => ({ results: { bindings: realm ? [{ resource: { type: 'uri', value: realm.resource },
      head: { type: 'uri', value: realm.head } }] : [] } }) },
  } as unknown as WorkActivationEnvironment;
  configureCampaignFixtureAncestry(env, realm);
  return env;
}

export function configureCampaignFixtureReader(env: WorkActivationEnvironment, read: DisclosureReader['read']) {
  configureDisclosure(env, fixtureDisclosureReader(read));
}
