import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import {
  captureDisclosure, configureDisclosure, configureDisclosureAncestrySource, disclose,
  discloseInventory, discloseInventoryWithAnonymousNames, discloseInventoryWithCost, DisclosureStore, DisclosureUnavailable,
  fenceDisclosure, requireEstablishedAncestry, resolveDisclosureSelections, type DisclosureAncestryEvidence,
  type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { governanceOwners } from '../src/modules/governance/schema.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { discloseContent, disclosureMedia } from '../src/modules/disclosure/assembly.ts';
import type { ExactReadResult } from '../../content/src/core.ts';
import type { MediaStore } from '../src/modules/media/store.ts';
import { ensureFixtureScopeGate } from '../src/modules/access/fixture-authority.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), head = id(2);
function fixture() {
  let open = true, restricted = false, nameVisible = true, cut = 'a'.repeat(64), liveHead = head;
  let recoveryGeneration = '1';
  let restrictedTarget = (_target: DisclosureTarget) => false;
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
    return { rows: complete ? targets.map(target => ({ ordinal: target.ordinal, open,
      restricted: restricted || restrictedTarget(target),
      realmClosed: false, nameVisible, publicNameVisible: nameVisible, assessments: [],
      recoveryGeneration, enforcementCut: cut })) : [] };
  } } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => ({ results: { bindings:
      [...(query.match(/VALUES \?work \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => ({ work: { value: match[1]! }, head: { value: liveHead },
          ...(match[1] === id(20) ? { nameOwner: { value: id(20) } } : {}),
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
    restrictTargets: (policy: typeof restrictedTarget) => { restrictedTarget = policy; },
    moveRecovery: () => { recoveryGeneration = '2'; },
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

test('strict ancestry inspection rejects missing and legacy evidence and preserves the established proof', async () => {
  const f = fixture(), input: DisclosureTarget = { owner: 'content', resource: id(10), component: 'body' };
  expect(() => requireEstablishedAncestry(input)).toThrow(DisclosureUnavailable);
  const [legacy] = await resolveDisclosureSelections(f.env, [input]);
  expect(() => requireEstablishedAncestry(legacy!)).toThrow(DisclosureUnavailable);
  expect(() => requireEstablishedAncestry({ ...input, ancestry: legacy!.ancestry })).toThrow(DisclosureUnavailable);
  const proof = evidence(f.env, input);
  configureDisclosureAncestrySource(f.env, 'content', { read: async () => [proof], reread: async () => [proof] });
  const [strict] = await resolveDisclosureSelections(f.env, [input]);
  expect(strict!.ancestry).toBe(requireEstablishedAncestry(strict!));
  expect(requireEstablishedAncestry(strict!).relationshipBasis).toEqual(proof.relationshipBasis);
});

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

test('P2-2 mixed registered and legacy owners pair visible, hidden, visible decisions with their original targets', async () => {
  const f = fixture(), strict = { owner: 'graph' as const, resource: id(11), component: 'record' as const };
  const proof = evidence(f.env, strict);
  configureDisclosureAncestrySource(f.env, 'graph', { read: async () => [proof], reread: async () => [proof] });
  f.restrictTargets(input => input.resource === strict.resource);
  const inputs = [target('content'), strict, target('source')];
  const selections = await resolveDisclosureSelections(f.env, inputs);
  expect(selections.map(selection => selection.target.owner)).toEqual(['content', 'graph', 'source']);
  expect('kind' in selections[0]!.ancestry).toBe(true);
  expect('kind' in selections[1]!.ancestry).toBe(false);
  expect(await discloseInventory(f.env, inputs, ANONYMOUS_VIEWER, 'search')).toEqual(['visible', 'hidden', 'visible']);
  expect(f.requested.at(-1)!.map(input => input.ancestry && 'kind' in input.ancestry)).toEqual([true, false, true]);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'search');
  expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'search')).toEqual(['visible', 'hidden', 'visible']);
  expect(f.requested.at(-1)!.map(input => input.ancestry && 'kind' in input.ancestry)).toEqual([true, false, true]);
  expect(f.requested.at(-1)!.map(input => input.owner)).toEqual(['content', 'graph', 'source']);
});

test('mixed submissions retain the strict policy-target contract for legacy entries', async () => {
  const f = fixture(), strict = { owner: 'graph' as const, resource: id(11), component: 'record' as const };
  const proof = evidence(f.env, strict);
  configureDisclosureAncestrySource(f.env, 'graph', { read: async () => [proof], reread: async () => [proof] });
  let observed = false;
  configureDisclosure(f.env, {
    read: f.reader.read.bind(f.reader),
    readAtCut: async (targets, ...args) => {
      observed = true;
      expect(Object.isFrozen(targets)).toBe(false);
      expect(targets.map(target => Object.isFrozen(target))).toEqual([false, false]);
      return f.reader.readAtCut(targets, ...args);
    },
  });
  const selections = await resolveDisclosureSelections(f.env, [target('content'), strict]);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(cuts.map(cut => cut.decision)).toEqual(['visible', 'visible']);
  expect(observed).toBe(true);
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

for (const timing of ['last', 'earlier'] as const) {
  for (const entry of ['capture', 'fence', 'inventory', 'paired inventory'] as const) {
    const size = timing === 'last' ? 65 : 129;
    const name = timing === 'last'
      ? 'legacy submission of 65 selections rejects when an owner registers during the last chunk'
      : 'legacy submission of 129 selections rejects when an owner registers during an earlier chunk';
    test(`${name}: ${entry}`, async () => {
      const f = fixture(), targets = Array.from({ length: size }, (_, index) => ({
        ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index),
      }));
      const selections = await resolveDisclosureSelections(f.env, targets);
      const cuts = entry === 'fence' ? await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read') : [];
      f.requested.length = 0;
      f.onStatement(() => {
        if (f.requested.length === 2) configureDisclosureAncestrySource(f.env, 'content', {
          read: async () => [], reread: async () => [],
        });
      });
      const submission = entry === 'capture' ? captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read')
        : entry === 'fence' ? fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')
        : entry === 'inventory' ? discloseInventory(f.env, targets, ANONYMOUS_VIEWER, 'read')
        : discloseInventoryWithAnonymousNames(f.env, targets, ANONYMOUS_VIEWER, 'read');
      await expect(submission).rejects.toBeInstanceOf(DisclosureUnavailable);
      expect(f.requested.map(batch => batch.length)).toEqual(timing === 'last' ? [64, 1] : [64, 64, 1]);
    });
  }
}

for (const entry of ['read', 'readWithAnonymousNames', 'readAtCut'] as const) {
  for (const issued of [false, true]) {
    test(`legacy store ${entry} rejects registration in the last chunk for ${issued ? 'issued' : 'bare'} targets`, async () => {
      const f = fixture(), targets = Array.from({ length: 65 }, (_, index) => ({
        ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index),
      }));
      const inputs = issued ? (await resolveDisclosureSelections(f.env, targets))
        .map(selection => ({ ...selection.target, ancestry: selection.ancestry })) : targets;
      f.onStatement(() => {
        if (f.requested.length === 2) configureDisclosureAncestrySource(f.env, 'content', {
          read: async () => [], reread: async () => [],
        });
      });
      await expect(f.reader[entry](inputs, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
      expect(f.requested.map(batch => batch.length)).toEqual([64, 1]);
    });
  }
}

test('legacy selection resolution rejects registration between chunks for an earlier owner', async () => {
  const f = fixture(), targets = Array.from({ length: 65 }, (_, index) => ({
    ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index),
  }));
  const submission = resolveDisclosureSelections(f.env, targets);
  // The first legacy chunk resolves synchronously; registration runs at its await.
  queueMicrotask(() => configureDisclosureAncestrySource(f.env, 'content', {
    read: async () => [], reread: async () => [],
  }));
  await expect(submission).rejects.toBeInstanceOf(DisclosureUnavailable);
});

for (const entry of ['read', 'readWithAnonymousNames', 'readAtCut', 'capture', 'fence'] as const) {
  test(`legacy ${entry} rejects original-owner registration after earlier caller identities move`, async () => {
    const f = fixture(), targets = Array.from({ length: 65 }, (_, index) => ({
      ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index),
    }));
    const selections = await resolveDisclosureSelections(f.env, targets);
    const cuts = entry === 'fence' ? await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read') : [];
    f.requested.length = 0;
    f.onStatement(() => {
      if (f.requested.length !== 2) return;
      targets.slice(0, 64).forEach(target => { target.owner = 'source'; });
      // Issued records are frozen, but the caller can still replace array entries.
      if (entry === 'capture') selections.fill(selections[64]!, 0, 64);
      if (entry === 'fence') cuts.fill(cuts[64]!, 0, 64);
      configureDisclosureAncestrySource(f.env, 'content', { read: async () => [], reread: async () => [] });
    });
    const submission = entry === 'capture' ? captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read')
      : entry === 'fence' ? fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')
      : f.reader[entry](targets, ANONYMOUS_VIEWER, 'read');
    await expect(submission).rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(targets.every(target => target.owner === 'source')).toBe(true);
    expect(f.requested.map(batch => batch.length)).toEqual([64, 1]);
    expect(f.requested[0]!.every(target => target.owner === 'content')).toBe(true);
  });
}

for (const entry of ['read', 'readWithAnonymousNames', 'readAtCut'] as const) {
  test(`legacy ${entry} snapshots later owner, resource, component, revision and occurrence before any chunk`, async () => {
    const f = fixture(), targets = Array.from({ length: 65 }, (_, index) => ({
      ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index), revision: 'revision:1',
      occurrence: { owner: 'content' as const, kind: 'publication' as const, resource: id(300), revision: 'publication:1' },
    }));
    const original = { ...targets[64]!, occurrence: { ...targets[64]!.occurrence } };
    f.onStatement(() => {
      if (f.requested.length !== 1) return;
      Object.assign(targets[64]!, { owner: 'content', resource: id(999), component: 'title', revision: 'revision:2' });
      targets[64]!.occurrence.revision = 'publication:2';
    });
    const result = await f.reader[entry](targets, ANONYMOUS_VIEWER, 'read');
    expect(Array.isArray(result) ? result : result.decisions).toEqual(targets.map(() => 'visible'));
    expect(f.requested[1]![0]).toMatchObject(original);
  });
}

test('legacy resolution snapshots later targets and occurrences before yielding the first chunk', async () => {
  const f = fixture(), targets = Array.from({ length: 65 }, (_, index) => ({
    ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index), revision: 'revision:1',
    occurrence: { owner: 'content' as const, kind: 'publication' as const, resource: id(300), revision: 'publication:1' },
  }));
  const original = { ...targets[64]!, occurrence: { ...targets[64]!.occurrence } };
  const submission = resolveDisclosureSelections(f.env, targets);
  queueMicrotask(() => {
    Object.assign(targets[64]!, { owner: 'content', resource: id(999), component: 'title', revision: 'revision:2' });
    targets[64]!.occurrence.revision = 'publication:2';
  });
  const selections = await submission;
  expect(selections[64]!.target).toEqual(original);
  expect(Object.isFrozen(selections[64]!.target)).toBe(true);
  expect(Object.isFrozen(selections[64]!.target.occurrence)).toBe(true);
});

for (const entry of ['inventory', 'paired inventory', 'capture', 'fence'] as const) {
  test(`legacy ${entry} freezes policy identities retained by a reader across chunks`, async () => {
    const f = fixture(), targets = Array.from({ length: 65 }, (_, index) => ({
      ...target(index < 64 ? 'content' : 'source'), resource: id(100 + index),
    }));
    let active = false, statements = 0, earlier: readonly DisclosureTarget[] = [];
    configureDisclosure(f.env, { read: async batch => {
      expect(Object.isFrozen(batch)).toBe(true);
      expect(batch.every(target => Object.isFrozen(target))).toBe(true);
      if (active && ++statements === 1) earlier = batch;
      if (active && statements === 2) {
        expect(Reflect.set(earlier[0]!, 'owner', 'source')).toBe(false);
        configureDisclosureAncestrySource(f.env, 'content', { read: async () => [], reread: async () => [] });
      }
      return batch.map(() => 'visible');
    } });
    const selections = await resolveDisclosureSelections(f.env, targets);
    const cuts = entry === 'fence' ? await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read') : [];
    active = true;
    const submission = entry === 'capture' ? captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read')
      : entry === 'fence' ? fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')
      : entry === 'inventory' ? discloseInventory(f.env, targets, ANONYMOUS_VIEWER, 'read')
      : discloseInventoryWithAnonymousNames(f.env, targets, ANONYMOUS_VIEWER, 'read');
    await expect(submission).rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(statements).toBe(2);
    expect(earlier.every(target => target.owner === 'content')).toBe(true);
  });
}

test('P1-2 legacy visible hydration cannot cross an Access recovery-generation change', async () => {
  const f = fixture(), selections = await resolveDisclosureSelections(f.env, [target('content')]);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  f.moveRecovery();
  await expect(fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
  const fresh = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(await fenceDisclosure(f.env, fresh, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
});

test('bare target snapshots preserve the selected identity during graph name lookup and policy evaluation', async () => {
  for (const field of ['resource', 'owner', 'component', 'revision'] as const) {
    const f = fixture(), input: DisclosureTarget = { owner: 'graph', resource: work, component: 'name' };
    f.hideName();
    const query = f.env.fuseki.query.bind(f.env.fuseki);
    f.env.fuseki.query = async (...args) => {
      const rows = await query(...args);
      if (field === 'resource') input.resource = id(20);
      else if (field === 'owner') input.owner = 'content';
      else if (field === 'component') input.component = 'body';
      else input.revision = id(21);
      return rows;
    };
    expect(await f.reader.read([input], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
    expect(f.requested.at(-1)![0]).toMatchObject({ owner: 'graph', resource: work, component: 'name' });
    f.env.fuseki.query = query;
    expect(await f.reader.read([{ owner: 'graph', resource: id(20), component: 'name' }], ANONYMOUS_VIEWER, 'read'))
      .toEqual(['hidden']);
  }
  const f = fixture(), input: DisclosureTarget = { owner: 'graph', resource: work, component: 'name', nameOwnerResolved: true };
  f.onStatement(() => { input.resource = id(20); });
  expect(await f.reader.read([input], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  expect(f.requested.at(-1)![0]!.resource).toBe(work);
});

const contentResult = (): Extract<ExactReadResult, { status: 'available' }> => ({
  status: 'available', revisionId: id(30).slice(-36), serializedJson: '{}', body: {},
  reference: { owner: 'content', resourceId: work, variantId: id(31).slice(-36), revisionId: id(30).slice(-36),
    format: 'rezics-content-json-v1', model: 'fixture-model', byteDigest: 'a'.repeat(64), byteLength: 2,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    sourceRevision: null, predecessor: null, provenance: {} },
});
const mediaBytes = () => ({ sha256: 'a'.repeat(64), availability: 'available', mediaType: 'image/png',
  byteLength: 100, clearance: 'cleared', owner: work, uploader: 'fixture', disclosure: 'public',
  moderation: 'clear', lifecycle: 'active', objectNamespace: 'media/' } as const);

test('P2-1 missing-reader Content and media retain legacy delivery, erasure suppression and audience gates', async () => {
  const f = fixture();
  configureDisclosure(f.env, null);
  const result = contentResult();
  expect(await discloseContent(f.env, [result])).toEqual([result]);
  const bytes = mediaBytes();
  const row = { ...bytes, asset: id(40).slice(-36), target: work, use: id(41).slice(-36),
    context: 'urn:rezics:context:global', selection: id(42).slice(-36), selectionPosition: '1',
    representation: id(43).slice(-36), crop: null, width: 128, height: 128, statePosition: '1',
    role: 'publication-item', focalArea: null, anchor: null };
  const store = disclosureMedia({ avatarDelivery: async () => row, itemDelivery: async () => row,
    itemDeliveryBatch: async () => new Map([[row.use, row]]), assetDelivery: async () => bytes } as unknown as MediaStore, f.env);
  expect(await store.avatarDelivery(id(42).slice(-36))).toEqual(row);
  expect(await store.itemDelivery(row.use)).toEqual(row);
  expect(await store.itemDeliveryBatch([row.use])).toEqual(new Map([[row.use, row]]));
  expect(await store.assetDelivery(row.asset, work)).toEqual(bytes);
  configureMediaVisibility({ environment: f.env, media: { store: {
    visibilityFacts: async (references: readonly string[]) => new Map(references.map(reference => [reference, {
      owner: work, pending: false, disclosure: 'public', attachments: [], attachmentOverflow: false, blocked: true,
    }])),
  } }, access: {} } as unknown as MainWorkDependencies);
  expect(await store.avatarDelivery(id(42).slice(-36))).toBeNull();
  expect(await store.itemDelivery(row.use)).toBeNull();
  expect(await store.itemDeliveryBatch([row.use])).toEqual(new Map());
  expect(await store.assetDelivery(row.asset, work)).toBeNull();
  const query = f.env.fuseki.query.bind(f.env.fuseki);
  f.env.fuseki.query = async (...args) => args[0].includes('SELECT ?target WHERE')
    ? { results: { bindings: [{ target: { type: 'uri', value: `urn:rezics:content:revision:${result.revisionId}` } }] } }
    : query(...args);
  expect(await discloseContent(f.env, [result])).toEqual([{ revisionId: result.revisionId, status: 'erased' }]);
  f.env.fuseki.query = query;
  configureDisclosure(f.env, { read: async targets => targets.map(() => 'hidden') });
  expect(await discloseContent(f.env, [result])).toEqual([{ revisionId: result.revisionId, status: 'denied' }]);
});

let cluster: PostgresCluster | undefined;
let policyPool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  policyPool = new Pool(cluster.connection);
  const root = resolve(import.meta.dir, '../../..');
  for (const file of schemaFiles(root, 'access')) {
    await policyPool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 60_000);
afterAll(async () => { if (policyPool) await policyPool.end(); cluster?.remove(); });

function policyEnvironment() {
  const f = fixture();
  configureDisclosure(f.env, new DisclosureStore(policyPool));
  return f.env;
}

test('P1-1 legacy final policy refuses a repeatable-read snapshot after a committed Work gate closure', async () => {
  const env = policyEnvironment();
  await ensureFixtureScopeGate(policyPool, `work:read:${work}`, { open: true });
  const selections = await resolveDisclosureSelections(env, [target('content')]);
  const cuts = await captureDisclosure(env, selections, ANONYMOUS_VIEWER, 'read');
  const stale = await policyPool.connect();
  try {
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await stale.query('SELECT open FROM access.recovery_fence WHERE id');
    await ensureFixtureScopeGate(policyPool, `work:read:${work}`, { open: false });
    await expect(fenceDisclosure(env, cuts, ANONYMOUS_VIEWER, 'read', stale))
      .rejects.toThrow('fresh Access snapshot');
    expect(await fenceDisclosure(env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
  } finally {
    await stale.query('ROLLBACK'); stale.release();
    await ensureFixtureScopeGate(policyPool, `work:read:${work}`, { open: true });
  }
});

test('P1-3 legacy Content restores its historical Work gate and media keeps its attached target gate', async () => {
  const env = policyEnvironment(), result = contentResult();
  await ensureFixtureScopeGate(policyPool, `work:read:${work}`, { open: true });
  expect(await discloseContent(env, [result])).toEqual([result]);
  const bytes = mediaBytes();
  const store = disclosureMedia({ assetDelivery: async () => bytes } as unknown as MediaStore, env);
  expect(await store.assetDelivery(id(40).slice(-36), work)).toEqual(bytes);
  await ensureFixtureScopeGate(policyPool, `work:read:${work}`, { open: false });
  expect(await discloseContent(env, [result])).toEqual([{ revisionId: result.revisionId, status: 'denied' }]);
  expect(await store.assetDelivery(id(40).slice(-36), work)).toBeNull();
  await ensureFixtureScopeGate(policyPool, `work:read:${work}`, { open: true });
});

test('P2-3 real legacy policy distinguishes Work revisions and includes owning-Work suitability labels', async () => {
  const env = policyEnvironment(), principal = randomUUID(), actor = id(50), caseId = randomUUID(), decision = randomUUID();
  const scope = 'governance:platform';
  await ensureFixtureScopeGate(policyPool, scope, { open: true });
  await policyPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principal, 'https://disclosure-policy.test', principal]);
  await policyPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  await policyPool.query(`INSERT INTO access.governance_case (id,kind,authority_kind,authority_scope_id,context,
    target_owner,target_resource,target_component,disclosure) VALUES ($1,'content_report','platform',$2,
    'urn:rezics:context:global','graph',$3,'title','parties')`, [caseId, scope, work]);
  await policyPool.query(`INSERT INTO access.moderation_decision (id,kind,outcome,context,case_id,case_sequence,
    principal_id,acting_subject,authority_kind,authority_scope_id,authority_epoch,authority_proof_digest,
    idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure,statement_of_reasons)
    VALUES ($1,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform',$5,0,
    $6,'legacy-revision-policy',$6,$4,'rule:1',$6,$6,'parties',$7)`,
  [decision, caseId, principal, actor, scope, 'a'.repeat(64), { facts: 'Fixture evidence', scope: 'Exact Work title',
    duration: 'Until restored', automation: false, appealRoute: '/v1/public-reports/fixture/correspondence', contentLanguage: 'en' }]);
  await policyPool.query(`INSERT INTO access.moderation_decision_target
    (decision_id,ordinal,owner,resource,component,scope_kind,revision,effect)
    VALUES ($1,1,'graph',$2,'title','exact_revision',$3,'disclosure')`, [decision, work, head]);
  await policyPool.query('UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1', [caseId, decision]);
  const enforcement = randomUUID();
  await policyPool.query(`INSERT INTO access.governance_enforcement (id,authority_scope_id,context,owner,resource,
    component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
    VALUES ($1,$2,'urn:rezics:context:global','graph',$3,'title',$4,'disclosure',$5,1,'restricted',1)`,
  [enforcement, scope, work, head, decision]);
  const current = { ...target('content'), workRevision: head }, previous = { ...current, workRevision: id(3) };
  expect(await discloseInventory(env, [current, previous], ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone', 'visible']);
  expect(await discloseInventory(env, [current, previous], ANONYMOUS_VIEWER, 'search')).toEqual(['hidden', 'visible']);
  await policyPool.query(`INSERT INTO access.suitability_assessment (id,target,labels,basis,assessor,principal_id,
    revision_number,authority_proof,idempotency_key,request_digest) VALUES ($1,$2,'{r18}','author',$3,$4,1,
    '{}','legacy-parent-suitability',$5)`, [randomUUID(), work, actor, principal, 'b'.repeat(64)]);
  expect(await discloseInventory(env, [previous], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  expect(await discloseInventory(env, [previous], ANONYMOUS_VIEWER, 'email')).toEqual(['hidden']);
  expect(await discloseInventory(env, [previous], ANONYMOUS_VIEWER, 'sitemap')).toEqual(['hidden']);
}, 30_000);
