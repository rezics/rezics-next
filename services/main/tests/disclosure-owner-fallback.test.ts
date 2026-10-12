import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  captureDisclosure, configureDisclosure, configureDisclosureAncestrySource, disclose,
  discloseInventory, discloseInventoryWithAnonymousNames, discloseInventoryWithCost, DisclosureStore, DisclosureUnavailable,
  fenceDisclosure, resolveDisclosureSelections, type DisclosureAncestryEvidence,
  type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { governanceOwners } from '../src/modules/governance/schema.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), head = id(2);
function fixture() {
  let open = true, restricted = false, nameVisible = true, cut = 'a'.repeat(64), liveHead = head;
  let complete = true, onStatement = () => {};
  const requested: DisclosureTarget[][] = [];
  const pool = { query: async (sql: string, args: unknown[]) => {
    expect(sql).toContain('FROM access.recovery_fence WHERE id LIMIT 1 FOR SHARE');
    expect(sql).toContain('wanted.legacy AND e.owner');
    expect(sql).toContain('wanted."workRevision" IS NULL');
    expect(sql).toContain("UNION SELECT wanted.work WHERE wanted.legacy");
    const targets = JSON.parse(String(args[0])) as (DisclosureTarget & { ordinal: number })[];
    if (targets.every(target => !target.ancestry || 'kind' in target.ancestry)) {
      expect(sql).not.toContain('access.site_moderation_basis()');
    }
    requested.push(targets);
    onStatement();
    return { rows: complete ? targets.map(target => ({ ordinal: target.ordinal, open, restricted,
      realmClosed: false, nameVisible, publicNameVisible: nameVisible, assessments: [],
      recoveryGeneration: '1', enforcementCut: cut })) : [] };
  } } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => ({ results: { bindings:
      [...(query.match(/VALUES \?work \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => ({ work: { value: match[1]! }, head: { value: liveHead },
          ...(match[1] === work ? { owningWork: { value: work }, owningHead: { value: liveHead } } : {}) })) } }),
  } } as unknown as WorkActivationEnvironment;
  const reader = new DisclosureStore(pool);
  configureDisclosure(env, reader);
  const unboundReader = new DisclosureStore({ query: pool.query.bind(pool) } as unknown as Pool);
  return { env, reader, unboundReader, requested, hold: () => { open = false; },
    restore: () => { open = true; }, restrict: () => { restricted = true; },
    hideName: () => { nameVisible = false; },
    partial: () => { complete = false; }, complete: () => { complete = true; },
    onStatement: (hook: () => void) => { onStatement = hook; },
    moveCut: () => { cut = 'b'.repeat(64); }, moveHead: () => { liveHead = id(3); } };
}
const target = (owner: DisclosureTarget['owner']): DisclosureTarget => ({
  owner, resource: id(10), component: 'body', work,
});
function evidence(env: WorkActivationEnvironment, target: DisclosureTarget): DisclosureAncestryEvidence {
  return { resource: target.resource, resourceKind: 'other', parents: [], status: 'complete',
    relationshipBasis: { owner: 'graph', kind: 'publication', resource: target.resource,
      revision: 'publication:1', targetResource: target.resource, targetRevision: target.revision ?? null,
      token: 'c'.repeat(64), dataEpoch: env.lineage.dataEpoch } };
}

for (const owner of governanceOwners) {
  test(`${owner} without an ancestry source retains hinted Work parents, current revisions and channel gates`, async () => {
    const f = fixture(), input = target(owner);
    const selections = await resolveDisclosureSelections(f.env, [input]);
    expect(selections[0]!.ancestry).toMatchObject({ kind: 'legacy' });
    const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
    expect(cuts[0]!.decision).toBe('visible');
    expect(f.requested.at(-1)![0]).toMatchObject({ work, workRevision: head });
    expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
    f.restrict();
    expect(await discloseInventory(f.env, [input], ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
    expect(await disclose(f.env, [input], ANONYMOUS_VIEWER, 'search')).toEqual(['hidden']);
  });
  test(`${owner} registration requires complete evidence and refuses previously issued legacy selections at every entry`, async () => {
    const f = fixture(), input = target(owner);
    const copiedEnvironment = { ...f.env };
    const selections = await resolveDisclosureSelections(f.env, [input]);
    const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
    const issued = { ...selections[0]!.target, ancestry: selections[0]!.ancestry };
    expect(await f.unboundReader.read([issued], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
    configureDisclosureAncestrySource(f.env, owner, { read: async () => [], reread: async () => [] });
    await expect(resolveDisclosureSelections(f.env, [input])).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(resolveDisclosureSelections(f.env, [issued])).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(discloseInventory(f.env, [issued], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(f.reader.read([issued], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(f.unboundReader.read([issued], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(f.reader.read([input], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(discloseInventory(copiedEnvironment, [input], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
  });
}

test('mixed registered and legacy owners preserve input order through resolution, inventory, capture and fence', async () => {
  const f = fixture(), strict = { owner: 'graph' as const, resource: id(11), component: 'record' as const };
  const proof = evidence(f.env, strict);
  configureDisclosureAncestrySource(f.env, 'graph', { read: async () => [proof], reread: async () => [proof] });
  const inputs = [target('content'), strict, target('source')];
  const selections = await resolveDisclosureSelections(f.env, inputs);
  expect(selections.map(selection => selection.target.owner)).toEqual(['content', 'graph', 'source']);
  expect('kind' in selections[0]!.ancestry).toBe(true);
  expect('kind' in selections[1]!.ancestry).toBe(false);
  expect(await discloseInventory(f.env, inputs, ANONYMOUS_VIEWER, 'search')).toEqual(['visible', 'visible', 'visible']);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible', 'visible', 'visible']);
  expect(f.requested.at(-1)!.map(input => input.owner)).toEqual(['content', 'graph', 'source']);
});

test('legacy structural ownership and names resolve the previous current Work revisions and paired name gate', async () => {
  const f = fixture(), input: DisclosureTarget = { owner: 'graph', resource: work, component: 'title' };
  expect(await f.reader.read([{ ...input, work }], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  expect(await discloseInventoryWithAnonymousNames(f.env, [input], ANONYMOUS_VIEWER, 'summary'))
    .toMatchObject({ decisions: ['visible'], anonymousNames: ['visible'], parentHeadQueries: 1 });
  expect(f.requested.at(-1)![0]).toMatchObject({ work, revision: head, workRevision: head });
  f.hideName();
  const named = { ...input, nameOwner: id(20) };
  expect(await discloseInventoryWithAnonymousNames(f.env, [named], ANONYMOUS_VIEWER, 'summary'))
    .toMatchObject({ decisions: ['hidden'], anonymousNames: ['hidden'] });
});

test('legacy final cuts retain recovery and current policy while an unrelated enforcement change causes zero replays', async () => {
  const f = fixture(), selections = await resolveDisclosureSelections(f.env, [target('content')]);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  const searchCuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'search');
  f.moveHead();
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  expect(f.requested.at(-1)![0]!.workRevision).toBe(id(3));
  f.hold();
  await expect(fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
  f.restore();
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  f.moveCut();
  const statements = f.requested.length;
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  expect(f.requested.length - statements).toBe(1);
  f.restrict();
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
  expect(await fenceDisclosure(f.env, searchCuts, ANONYMOUS_VIEWER, 'search')).toEqual(['hidden']);
});

test('a legacy inventory of 501 targets uses the previous eight bounded owner statements', async () => {
  const f = fixture(), targets = Array.from({ length: 501 }, (_, index) => ({
    ...target('content'), resource: id(100 + index),
  }));
  expect(await discloseInventoryWithCost(f.env, targets, ANONYMOUS_VIEWER, 'sitemap'))
    .toMatchObject({ decisions: targets.map(() => 'visible'), parentHeadQueries: 1 });
  expect(f.requested).toHaveLength(8);
  expect(f.requested.map(batch => batch.length)).toEqual([64, 64, 64, 64, 64, 64, 64, 53]);
  const selections = await resolveDisclosureSelections(f.env, targets);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(cuts).toHaveLength(501);
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(targets.map(() => 'visible'));
  expect(f.requested).toHaveLength(24);
});

test('legacy reads reject partial policy results and retry current policy after recovery', async () => {
  const f = fixture();
  f.partial();
  await expect(discloseInventory(f.env, [target('content')], ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
  f.complete();
  expect(await discloseInventory(f.env, [target('content')], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
});

test('registering an owner source during a legacy policy statement invalidates that response', async () => {
  const f = fixture();
  f.onStatement(() => configureDisclosureAncestrySource(f.env, 'content', {
    read: async () => [], reread: async () => [],
  }));
  await expect(discloseInventory(f.env, [target('content')], ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
});
