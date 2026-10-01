import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient, type CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { deliverRealmPolicy, type RealmPolicyDelivery } from '../src/modules/space/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { pendingRealmPolicies } from '../src/modules/access/realm-management-recovery.ts';

const intent: RealmPolicyDelivery = { realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  receipt_id: '00000000-0000-4000-8000-000000000002', generation: '18', visibility: 'private', review_mode: 'open' };
for (const version of [undefined, 'space-realm-v1', 'space-realm-v2', 'space-realm-v3'] as const) {
  test(`G-915: ${version ?? 'implicit v1'} policy uses its reviewed profile and replays a lost response`, async () => {
    let committed = false;
    const envelopes: CommandEnvelope[] = [];
    const fuseki = new FusekiClient('http://graph.test/');
    fuseki.query = async query => query.includes('ASK') ? { boolean: committed } : { results: { bindings: [{
      space: { type: 'uri', value: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003' },
      ...(version ? { spaceProfile: { type: 'uri', value: `https://rezics.com/definition/${version}` },
        realmProfile: { type: 'uri', value: `https://rezics.com/definition/${version}` } } : {}),
    }] } };
    fuseki.commandHealth = async () => ({ moduleVersion: '', instanceId: '', publicSearchWriteEpoch: '',
      publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) });
    fuseki.commandWithReceipt = async envelope => {
      envelopes.push(envelope);
      committed = true;
      throw new Error('Graph committed, response lost');
    };
    const env: WorkActivationEnvironment = { fuseki, objectDirectory: '', lineage: { dataEpoch: '1', routingEpoch: '1' } };
    await deliverRealmPolicy(env, intent);
    await deliverRealmPolicy(env, intent);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.validations.map(entry => entry.profile)).toEqual([version ?? 'space-realm-v1', version ?? 'space-realm-v1']);
    expect(envelopes[0]!.validations.map(entry => entry.shape)).toEqual([
      `https://rezics.com/definition/${version ?? 'space-realm-v1'}/space-shape`,
      `https://rezics.com/definition/${version ?? 'space-realm-v1'}/realm-shape`,
    ]);
  });
}

test('G-915: mismatched Realm/Space profiles stay pending without a graph write', async () => {
  const fuseki = new FusekiClient('http://graph.test/');
  fuseki.query = async query => query.includes('ASK') ? { boolean: false } : { results: { bindings: [{
    space: { type: 'uri', value: intent.realm },
    spaceProfile: { type: 'uri', value: 'https://rezics.com/definition/space-realm-v2' },
    realmProfile: { type: 'uri', value: 'https://rezics.com/definition/space-realm-v3' },
  }] } };
  fuseki.commandWithReceipt = async () => { throw new Error('Unexpected write'); };
  await expect(deliverRealmPolicy({ fuseki, objectDirectory: '', lineage: { dataEpoch: '1', routingEpoch: '1' } }, intent))
    .rejects.toThrow('profile is inconsistent');
});

test('G-915: recovery pages reject unbounded requests before storage access', async () => {
  const unusedPool = {} as Pool;
  for (const limit of [0, -1, 51, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    await expect(pendingRealmPolicies(unusedPool, undefined, limit)).rejects.toThrow('Invalid policy recovery page');
  }
  await expect(pendingRealmPolicies(unusedPool, 'invalid-cursor')).rejects.toThrow('Invalid policy recovery page');
});
