import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  captureDisclosure,
  configureDisclosure,
  configureDisclosureAncestrySource,
  DisclosureStore,
  fenceDisclosure,
  resolveDisclosureSelections,
  type DisclosureAncestryEvidence,
  type DisclosureRelationshipBasis,
  type DisclosureTarget,
} from '../../../services/main/src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../../../services/main/src/modules/suitability/policy.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const native = (index: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const resource = native(101), oldHead = native(102), currentHead = native(103);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface PolicyTarget {
  ordinal: number;
  revision: string | null;
  parents: { resource: string; head: string | null }[];
}

function fixture(target: DisclosureTarget, resourceKind: DisclosureAncestryEvidence['resourceKind'],
  nativeHome = false) {
  let heldRevision = oldHead;
  const policyTargets: PolicyTarget[] = [];
  const graphQueries: string[] = [];
  const pool = {
    query: async (_sql: string, args: unknown[]) => {
      const targets = JSON.parse(String(args[0])) as PolicyTarget[];
      policyTargets.push(...targets);
      return { rows: targets.map(input => ({
        ordinal: input.ordinal, open: true, realmClosed: false, assessments: [],
        restricted: nativeHome
          ? input.parents.some(parent => parent.resource === resource
            && (parent.head === null || parent.head === heldRevision))
          : input.revision === null || input.revision === heldRevision,
        nameVisible: true, publicNameVisible: true,
        recoveryGeneration: '1', enforcementCut: hash('current-head-cut'),
      })) };
    },
  } as unknown as Pool;
  const env = {
    lineage: { dataEpoch: 'current-head-epoch', routingEpoch: 'current-head-routing' },
    fuseki: {
      query: async (query: string) => {
        graphQueries.push(query);
        // This owner fixture stores native home heads only in homeDocumentHead.
        const hasHead = !nativeHome || query.includes('rv:ZoneHomeDocument')
          && query.includes('rv:homeDocumentHead');
        const named = query.includes('SELECT ?work');
        return { results: { bindings: hasHead
          ? [{ [named ? 'work' : 'resource']: { value: resource }, head: { value: currentHead } }]
          : named ? [{ work: { value: resource } }] : [] } };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const relationshipBasis: DisclosureRelationshipBasis = {
    owner: target.owner === 'content' ? 'content' : 'graph',
    kind: nativeHome ? 'work-ownership' : 'identity',
    resource: nativeHome ? target.resource : resource,
    revision: nativeHome ? target.revision! : currentHead,
    targetResource: target.resource, targetRevision: target.revision ?? null,
    token: hash(JSON.stringify(target)), dataEpoch: env.lineage.dataEpoch,
  };
  const evidence: DisclosureAncestryEvidence = {
    resource: target.resource, resourceKind, relationshipBasis, status: 'complete',
    parents: nativeHome ? [{
      owner: 'graph', kind: 'work', resource, head: currentHead, relationshipBasis,
    }] : [],
  };
  const reader = new DisclosureStore(pool);
  configureDisclosure(env, reader);
  configureDisclosureAncestrySource(env, target.owner, {
    read: async () => [evidence], reread: async () => [evidence],
  });
  return { env, reader, policyTargets, graphQueries, holdCurrent: () => { heldRevision = currentHead; } };
}

test('current graph names use the established identity head without a self-parent', async () => {
  for (const resourceKind of ['work', 'realm', 'other'] as const) {
    for (const component of ['name', 'title'] as const) {
      const target: DisclosureTarget = { owner: 'graph', resource, component };
      const f = fixture(target, resourceKind);
      const selections = await resolveDisclosureSelections(f.env, [target]);
      expect(selections[0]!.ancestry.parents).toEqual([]);
      const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
      expect(cuts[0]!.decision).toBe('visible');
      expect(f.policyTargets[0]!.revision).toBe(currentHead);
      expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
      const issued = { ...selections[0]!.target, ancestry: selections[0]!.ancestry };
      expect(await f.reader.readWithAnonymousNames([issued], ANONYMOUS_VIEWER, 'summary')).toEqual({
        decisions: ['visible'], anonymousNames: ['visible'],
      });
      f.holdCurrent();
      expect(await f.reader.read([issued], ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
      const historical = fixture({ ...target, revision: oldHead }, resourceKind);
      const historicalSelections = await resolveDisclosureSelections(historical.env, [{ ...target, revision: oldHead }]);
      const historicalCuts = await captureDisclosure(historical.env, historicalSelections, ANONYMOUS_VIEWER, 'read');
      expect(historicalCuts[0]!.decision).toBe('tombstone');
      expect(historical.policyTargets[0]!.revision).toBe(oldHead);
    }
  }
});

test('native home Content parent heads remain current through capture and final fence', async () => {
  const target: DisclosureTarget = {
    owner: 'content', resource: 'urn:rezics:content:home-body', component: 'body',
    revision: 'urn:rezics:content:revision:home-body-current',
  };
  const f = fixture(target, 'other', true);
  const selections = await resolveDisclosureSelections(f.env, [target]);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(cuts[0]!.decision).toBe('visible');
  expect(f.policyTargets[0]!.parents[0]!.head).toBe(currentHead);
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  expect(f.graphQueries).toHaveLength(2);
  f.holdCurrent();
  const held = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(held[0]!.decision).toBe('tombstone');
});
