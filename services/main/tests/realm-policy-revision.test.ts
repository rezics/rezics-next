import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { deliverRealmPolicy, policyHead, readRealmPolicy, type RealmPolicyDelivery } from '../src/modules/space/policy.ts';
import { realmSelectionDigest, type SelectRealmLocalInput } from '../src/modules/work/select-realm.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from '../src/modules/space/create.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const receiptId = '00000000-0000-4000-8000-000000000003';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const intent: RealmPolicyDelivery = { realm, receipt_id: receiptId, generation: '2',
  visibility: 'public', review_mode: 'open', listing: 'listed', history: 'everything', admission: 'invitation' };

function graph(loseResponse = false) {
  const writes: CommandEnvelope[] = [];
  const receipts = new Map<string, string>();
  const env = { lineage: { dataEpoch: 'policy-epoch', routingEpoch: 'policy-routing' }, objectDirectory: '', fuseki: {
    query: async (sql: string) => {
      if (sql.includes('ASK')) return { boolean: [...receipts].some(([receipt, digest]) =>
        sql.includes(`<${receipt}>`) && sql.includes(JSON.stringify(digest))) };
      return { results: { bindings: [{ space: { type: 'uri', value: space } }] } };
    },
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([id, profile]) => [id, profile.sha256])) }),
    commandWithReceipt: async (command: CommandEnvelope) => {
      writes.push(command);
      receipts.set(command.receipt, command.digest);
      if (loseResponse) throw new Error('Graph response lost after commit');
    },
  } } as unknown as WorkActivationEnvironment;
  return { env, writes, receipts };
}

test('new policy delivery publishes the exact immutable receipt and resolves a lost graph response', async () => {
  const h = graph(true);
  const op = { ...intent, policy_head: policyHead(receiptId) };
  await deliverRealmPolicy(h.env, op);
  await deliverRealmPolicy(h.env, op);
  expect(h.writes).toHaveLength(1);
  const command = h.writes[0]!;
  expect(command.receipt).toBe(`urn:rezics:receipt:${sha(`${receiptId}\0realm-policy-publish-v1`)}`);
  expect(command.digest).toBe(sha(JSON.stringify(intent)));
  expect(command.update).toContain(`rv:realmPolicyHead <${command.receipt}>`);
  expect(command.update).toContain(`<${command.receipt}> a rv:OperationReceipt`);
  expect(command.update).toContain('rv:restoreHold true');
  expect(command.update).toContain('rv:dataEpoch "policy-epoch"');
  expect(command.update).toContain('rv:routingEpoch "policy-routing"');
});

test('legacy deliveries preserve their receipt and exact request bytes after adding nullable storage metadata', async () => {
  for (const payload of [intent, { realm, receipt_id: receiptId, generation: '2',
    visibility: 'public', review_mode: 'open' } as RealmPolicyDelivery]) {
    const h = graph(true);
    const legacyHead = `urn:rezics:realm-policy:${receiptId}`;
    await deliverRealmPolicy(h.env, payload);
    await deliverRealmPolicy(h.env, { ...payload, policy_head: null });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.receipt).toBe(legacyHead);
    expect(h.writes[0]!.digest).toBe(sha(JSON.stringify(payload)));
    expect(h.receipts.has(policyHead(receiptId))).toBe(false);
  }
});

test('legacy Realm reads return the original pin without deriving a new receipt', async () => {
  const legacyHead = `urn:rezics:realm-policy:${receiptId}`;
  const h = graph();
  h.env.fuseki.query = async () => ({ results: { bindings: [{
    space: { type: 'uri', value: space }, disclosure: { type: 'uri', value: `${RV}Public` },
    visibility: { type: 'literal', value: 'public' }, mode: { type: 'literal', value: 'open' },
    head: { type: 'uri', value: legacyHead },
  }] } });
  expect(await readRealmPolicy(h.env, realm)).toMatchObject({ revision: legacyHead, reviewMode: 'open' });
  expect(h.writes).toHaveLength(0);
});

test('selection intents retain exact legacy pins and bind new receipt pins to different digests', () => {
  const input: SelectRealmLocalInput = { context: { kind: 'realm-local', id: realm },
    work: realm, mainVersion: space, contribution: realm, publicationDecision: space,
    expectedSelectionHead: null, selectionBasis: 'realm-policy', actingSubject: space,
    policy: { revision: `urn:rezics:realm-policy:${receiptId}`, mode: 'open' } };
  const retained = sha(JSON.stringify({ family: 'select-realm-local-v1', context: input.context,
    work: input.work, mainVersion: input.mainVersion, contribution: input.contribution,
    publicationDecision: input.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'realm-policy', policy: input.policy, actor: input.actingSubject,
    selectionPolicy: SELECTION_POLICY, reviewPolicy: REVIEW_POLICY }));
  expect(realmSelectionDigest(input)).toBe(retained);
  expect(realmSelectionDigest({ ...input, policy: { ...input.policy!, revision: policyHead(receiptId) } }))
    .not.toBe(retained);
});
