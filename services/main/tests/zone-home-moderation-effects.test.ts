import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { ContentModeration } from '../../content/src/moderation.ts';
import { ownerModerationEffects } from '../src/modules/governance/effects.ts';
import type { DecisionTargetInput } from '../src/modules/governance/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

// Native home restrictions and restorations must validate P's own shape and CAS its H head, never a Work or the Zone.
for (const outcome of ['restrict', 'restore'] as const) {
  test.failing(`native home ${outcome} uses its publication shape and head in the existing moderation owner`, async () => {
    const resource = id(), head = id(), zone = id();
    const target: DecisionTargetInput = { owner: 'graph', resource, component: 'record',
      scopeKind: outcome === 'restrict' ? 'component' : 'exact_revision', revision: outcome === 'restrict' ? null : head,
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
