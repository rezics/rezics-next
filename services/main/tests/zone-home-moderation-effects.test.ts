import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { ContentModeration } from '../../content/src/moderation.ts';
import { ownerModerationEffects } from '../src/modules/governance/effects.ts';
import type { DecisionTargetInput } from '../src/modules/governance/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { discloseContent } from '../src/modules/disclosure/assembly.ts';
import type { ExactReadResult } from '../../content/src/core.ts';
import { zoneHomeTargetFixture, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

// The native graph effect writer still selects the Work shape and rv:head for home records.
for (const outcome of ['restrict', 'restore'] as const) {
  for (const scopeKind of ['component', 'exact_revision'] as const) {
    test.failing(`native home ${outcome} at ${scopeKind} scope uses its publication shape and head`, async () => {
      const resource = id(), head = id(), zone = id();
      const target: DecisionTargetInput = { owner: 'graph', resource, component: 'record',
        scopeKind, revision: scopeKind === 'component' ? null : head,
        expectedHead: head, locator: null, effect: 'disclosure' };
      let committed: { digest: string } | null = null;
      const commands: Parameters<FusekiClient['commandWithReceipt']>[0][] = [];
      const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
        fuseki: {
          commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
            .map(([key, value]) => [key, value.sha256])) }),
          query: async (query: string) => query.includes('SELECT ?digest ?target ?head')
            ? { results: { bindings: committed ? [{ digest: { value: committed.digest },
              target: { value: resource }, head: { value: head } }] : [] } }
            : { boolean: query.includes('a rv:ZoneHomeDocument') },
          commandWithReceipt: async (command: Parameters<FusekiClient['commandWithReceipt']>[0]) => {
            commands.push(command);
            const nativeShape = command.validations?.some(validation => validation.profile === 'zone-capability-v1'
              && validation.shape === 'https://rezics.com/definition/zone-capability-v1/home-document-shape'
              && validation.focus.includes(resource));
            const nativeHead = command.update.includes(`<${resource}> rv:homeDocumentHead <${head}>`);
            if (!nativeShape || !nativeHead) return { status: 'invalid', report: 'Native home is not a Work and has no rv:head' };
            committed = { digest: command.digest };
            return { status: 'committed' };
          },
        } } as unknown as WorkActivationEnvironment;
      const effects = ownerModerationEffects({ apply: async () => { throw new Error('Content must not own native H'); } } as unknown as
        ContentModeration, env);
      expect(await effects.apply(randomUUID(), 1, target, { outcome })).toHaveProperty('receipt');
      expect(commands).toHaveLength(1);
      expect(commands[0]!.update).not.toContain(`<${zone}>`);
      expect(commands[0]!.validations?.every(validation => !validation.focus.includes(zone))).toBe(true);
    });
  }
}

function homeBodyRestriction(heldCurrent: boolean) {
  const h = zoneHomeTargetFixture(), held = heldCurrent ? h.revision : id();
  const graph = h.env.fuseki.query.bind(h.env.fuseki);
  h.env.fuseki.query = async (query, budget) => {
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      return { results: { bindings: [{ work: cell(h.resource),
        ...(query.includes('rv:homeDocumentHead') ? { head: cell(h.revision) } : {}) }] } };
    }
    return graph(query, budget);
  };
  configureDisclosure(h.env, { read: async targets => targets.map(target => {
    // Match the enforcement owner's conservative parent rule: a missing head cannot exclude an exact restriction.
    const restricted = target.owner === 'graph' && target.resource === h.resource && target.revision === held
      || target.owner === 'content' && target.work === h.resource
        && (target.workRevision == null || target.workRevision === held);
    return restricted ? 'hidden' : 'visible';
  }) });
  const exact: ExactReadResult[] = h.selections.map(selection => ({ revisionId: selection.revisionId, status: 'available',
    reference: { owner: 'content', resourceId: h.resource, ...selection, byteLength: 2,
      model: 'zone-page-v1', format: 'rezics-content-json-v1', direction: 'ltr', sourceRevision: null,
      predecessor: null, provenance: {}, language: { kind: 'tag', tag: selection.language, originalTag: selection.language } },
    serializedJson: '{}', body: {} }));
  return { h, exact };
}

// The Content parent probe still reads rv:head, so a native home's missing H broadens an exact-H restriction.
test.failing('an exact restriction on an older H does not suppress bytes selected by the current unheld H', async () => {
  const { h, exact } = homeBodyRestriction(false);
  expect(await discloseContent(h.env, exact)).toEqual(exact);
});

test('the Content delivery adapter withholds every selected body of the currently restricted H', async () => {
  const { h, exact } = homeBodyRestriction(true);
  expect(await discloseContent(h.env, exact)).toEqual(exact.map(result => ({ revisionId: result.revisionId, status: 'denied' })));
});
