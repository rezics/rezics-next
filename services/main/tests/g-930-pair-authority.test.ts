import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { EditorialBlocked, EditorialInvalid, type Proposal } from '../src/modules/editorial-review/contract.ts';
import { mergeTargets, proposalTargets, requireMergeDisclosure, requireMergeEdit } from '../src/modules/identity-merge/pair-authority.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const source = { resource: native(),revision: native() },survivor = { resource: native(),revision: native() };
const target = { ...source,work: source.resource,context: 'urn:rezics:context:global' as const };
const plan = { operation: 'merge',source,survivor,evidence: [{ ...source,locator: 'title and grain' }] };

test('G930: authority comes from both exact pins of the retained latest candidate, including unmerge', async () => {
  const proposal: Proposal = { id: randomUUID(),kind: 'merge',target,proposer: native(),proposerKey: 'proposer',latestRevision: 2,decision: null };
  const calls: unknown[][] = [];
  const client = { query: (_sql: string,args: unknown[]) => {
    calls.push(args); return Promise.resolve({ rows: [{ candidate: JSON.stringify(plan) }] });
  } } as unknown as PoolClient;
  const targets = await proposalTargets(client,proposal);
  expect(targets.map(({ resource,work,revision }) => ({ resource,work,revision }))).toEqual([
    { ...source,work: source.resource },{ ...survivor,work: survivor.resource },
  ]);
  expect(calls).toEqual([[proposal.id,2]]);
  expect(mergeTargets(target,{ ...plan,operation: 'unmerge',original: `editorial:${randomUUID()}:1` })).toEqual(targets);
  expect(() => mergeTargets({ ...target,resource: native() },plan)).toThrow(EditorialInvalid);
  expect(() => mergeTargets(target,{ ...plan,survivor: source })).toThrow(EditorialInvalid);
  expect(() => mergeTargets(target,{ ...plan,authorityWorks: [source.resource] })).toThrow(EditorialInvalid);
});

test('G930: public source disclosure cannot contract into a restricted survivor, and absent publication evidence fails closed', async () => {
  let sourcePublic = true,survivorPublic = false;
  const calls: string[] = [];
  const graph = { query: (sql: string) => {
    calls.push(sql); return Promise.resolve({ boolean: !sourcePublic || survivorPublic });
  } } as unknown as Pick<FusekiClient,'query'>;
  await expect(requireMergeDisclosure(plan,graph)).rejects.toBeInstanceOf(EditorialInvalid);
  expect(calls).toHaveLength(1);
  survivorPublic = true;
  await requireMergeDisclosure(plan,graph);
  sourcePublic = false;
  await requireMergeDisclosure(plan,graph);
  survivorPublic = false;
  await requireMergeDisclosure(plan,graph);
  await expect(requireMergeDisclosure(plan,undefined)).rejects.toBeInstanceOf(EditorialBlocked);
  await expect(requireMergeDisclosure(plan,{ query: () => Promise.reject(new Error('Publication owner unavailable')) }))
    .rejects.toThrow('Publication owner unavailable');
});

test('G930: a closed survivor owner gate rejects even with a current source grant, without probing unrelated Works', async () => {
  const gates: string[] = [],heldGrants: string[] = [];
  const client = { query: (sql: string,args: string[]) => {
    if (sql.includes('FROM access.scope_gate')) {
      gates.push(args[0]!);
      return Promise.resolve({ rows: [{ open: args[0] !== `work:edit:${survivor.resource}`,dispatch_open: true }] });
    }
    if (sql.includes('FROM access.representation r')) return Promise.resolve({ rows: [{ id: 'mandate',generation: '1',subject_generation: '1' }] });
    if (sql.includes('FROM access.permission_grant')) {
      heldGrants.push(args[0]!);
      return Promise.resolve({ rows: sql.includes('membership_id')
        ? [{ membership_id: null,membership_generation: null }] : [{ id: 'source-grant',generation: '1' }] });
    }
    throw new Error(`Unexpected authority lookup: ${sql}`);
  } } as unknown as PoolClient;
  await expect(requireMergeEdit(client,randomUUID(),native(),mergeTargets(target,plan),undefined))
    .rejects.toMatchObject({ blocker: { code: 'owner_authority_required',action: 'work.edit',scope: `work:edit:${survivor.resource}` } });
  expect(gates).toEqual([`work:edit:${source.resource}`,`work:edit:${survivor.resource}`]);
  expect(heldGrants).toHaveLength(2);
});
