import { expect, test } from 'bun:test';
import { DISCLOSURE_SUBMISSION_LIMIT } from '../../../services/main/src/modules/disclosure/contract-batching.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  captureDisclosure,
  configureDisclosure,
  configureDisclosureAncestrySource,
  DISCLOSURE_COST,
  DisclosureUnavailable,
  DisclosureStore,
  disclose,
  discloseInventory,
  discloseInventoryWithCost,
  fenceDisclosure,
  requireEstablishedAncestry,
  resolveDisclosureSelections,
  type DisclosureAncestryEvidence,
  type DisclosureAncestrySource,
  type DisclosureDecision,
  type DisclosureFenceBasis,
  type DisclosureReader,
  type DisclosureRelationshipBasis,
  type DisclosureTarget,
  type OwnerEstablishedGraphParent,
  type OwnerEstablishedGraphParents,
} from '../../../services/main/src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { ANONYMOUS_VIEWER } from '../../../services/main/src/modules/suitability/policy.ts';
import {
  discloseContent,
  disclosureMedia,
} from '../../../services/main/src/modules/disclosure/assembly.ts';
import type { ExactReadResult } from '../../../services/content/src/core.ts';
import type { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { discloseInventoryWithAnonymousNames } from '../../../services/main/src/modules/disclosure/read.ts';
import { configureMediaVisibility } from '../../../services/main/src/modules/media/visibility.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';

const native = (index: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const work = native(1),
  realm = native(2),
  workHead = native(3),
  realmHead = native(4);
const target: DisclosureTarget = {
  owner: 'content',
  resource: 'urn:rezics:reply:fixture',
  component: 'body',
  revision: 'urn:rezics:content:revision:fixture',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function basis(input: DisclosureTarget = target, token = 'current'): DisclosureRelationshipBasis {
  return {
    owner: input.owner === 'graph' ? 'graph' : input.owner === 'media' ? 'media' : 'content',
    kind: input.owner === 'media' ? 'media-use' : 'realm-placement',
    resource: 'urn:rezics:placement:fixture',
    revision: 'urn:rezics:placement:revision:fixture',
    ...(input.occurrence ? { owner: input.occurrence.owner, kind: input.occurrence.kind,
      resource: input.occurrence.resource, revision: input.occurrence.revision } : {}),
    targetResource: input.resource,
    targetRevision: input.revision ?? null,
    token: hash(token),
    dataEpoch: 'fixture-epoch',
  };
}
function parent(
  kind: 'work' | 'realm',
  input: DisclosureTarget = target,
): OwnerEstablishedGraphParent {
  return {
    owner: 'graph',
    kind,
    resource: kind === 'work' ? work : realm,
    head: kind === 'work' ? workHead : realmHead,
    relationshipBasis: { ...basis(input), kind: kind === 'work' ? 'work-ownership' : 'realm-placement' },
  };
}
function evidence(
  input: DisclosureTarget,
  parents: OwnerEstablishedGraphParents = [],
): DisclosureAncestryEvidence {
  return {
    resource: input.resource,
    resourceKind: 'other',
    relationshipBasis: basis(input),
    parents,
    status: 'complete',
  };
}

function fixture(parents: OwnerEstablishedGraphParents = [parent('work'), parent('realm')]) {
  let rows: DisclosureAncestryEvidence[] = [evidence(target, parents)];
  let batchInputs: readonly DisclosureTarget[] | undefined;
  let unavailable = false;
  let decisions: DisclosureDecision[] | undefined;
  let fenceBasis: DisclosureFenceBasis = {
    recoveryGeneration: '1',
    enforcementCut: hash('fixture-cut-1'),
  };
  const heads = new Map([
    [work, workHead],
    [realm, realmHead],
  ]);
  const headQueries: string[] = [],
    ownerReads: DisclosureTarget[][] = [],
    anonymousFlags: boolean[] = [];
  const env = {
    lineage: { dataEpoch: 'fixture-epoch', routingEpoch: 'fixture-routing' },
    fuseki: {
      query: async (query: string) => {
        headQueries.push(query);
        return {
          results: {
            bindings: [...heads]
              .filter(([resource]) => query.includes(`<${resource}>`))
              .map(([resource, head]) => ({
                resource: { value: resource },
                head: { value: head },
              })),
          },
        };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const source: DisclosureAncestrySource = {
    read: async inputs => {
      if (unavailable) throw new Error('owner source offline');
      return batchInputs ? inputs.map(input => rows[batchInputs!.findIndex(selected => selected.resource === input.resource)]!)
        : rows;
    },
    reread: async bases => {
      if (unavailable) throw new Error('owner source offline');
      return batchInputs ? bases.map(basis => rows[batchInputs!.findIndex(selected => selected.resource === basis.targetResource)]!)
        : rows;
    },
  };
  const reader: DisclosureReader = {
    read: async (inputs) => inputs.map(() => 'visible'),
    readAtCut: async (inputs, _viewer, _channel, _client, anonymousNames = false) => {
      ownerReads.push([...inputs]);
      anonymousFlags.push(anonymousNames);
      return {
        decisions: decisions ?? inputs.map(() => 'visible'),
        anonymousNames: inputs.map(() => 'hidden'),
        fenceBases: inputs.map(() => ({ ...fenceBasis })),
      };
    },
  };
  configureDisclosure(env, reader);
  configureDisclosureAncestrySource(env, 'content', source);
  return {
    env,
    heads,
    headQueries,
    ownerReads,
    anonymousFlags,
    source,
    reader,
    setEvidence: (value: DisclosureAncestryEvidence[], inputs?: readonly DisclosureTarget[]) => {
      rows = value;
      batchInputs = inputs;
    },
    setOffline: () => {
      unavailable = true;
    },
    setDecisions: (value: DisclosureDecision[]) => {
      decisions = value;
    },
    setFence: (value: DisclosureFenceBasis) => {
      fenceBasis = value;
    },
  };
}

test('paired media selections probe only the issued Use and preserve Asset governance targets', async () => {
  for (const state of ['missing', 'detached', 'overbroad'] as const) {
    const f = fixture();
    const use = native(901), asset = native(902);
    const targets: DisclosureTarget[] = [
      { owner: 'media', resource: asset, component: 'cover' },
      { owner: 'media', resource: use, component: 'media_use' },
    ];
    f.setEvidence(targets.map(input => ({ ...evidence(input), relationshipBasis: {
      ...basis(input), resource: use, revision: use,
    } })));
    configureDisclosureAncestrySource(f.env, 'media', f.source);
    const probes: string[][] = [];
    configureMediaVisibility({ environment: f.env, media: { store: {
      visibilityFacts: async (references: readonly string[]) => {
        probes.push([...references]);
        return state === 'missing' ? new Map() : new Map([[use, {
          owner: native(903), disclosure: 'public', pending: false, blocked: false,
          attachments: state === 'detached' ? [] : [
            { target: work, context: realm }, { target: native(904), context: realm },
          ],
        }]]);
      },
    } }, access: {} } as unknown as MainWorkDependencies);
    const selections = await resolveDisclosureSelections(f.env, targets);
    const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'media');
    expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'media')).toEqual(['hidden', 'hidden']);
    expect(probes).toEqual([[use], [use]]);
    expect(f.ownerReads.map(inputs => inputs.map(input => input.resource))).toEqual([[asset, use], [asset, use]]);
    expect(f.headQueries).toHaveLength(0);
  }
});
async function captured(f: ReturnType<typeof fixture>) {
  return captureDisclosure(
    f.env,
    await resolveDisclosureSelections(f.env, [target]),
    ANONYMOUS_VIEWER,
    'read',
  );
}

test('disclosure policy batches reject missing ancestry, forged descriptors and invalid legacy Work identities', async () => {
  const pool = { query: async (_sql: string, params: unknown[]) => ({ rows:
    (JSON.parse(params[0] as string) as { ordinal: number }[]).map(({ ordinal }) => ({
      ordinal, open: true, restricted: false, realmClosed: false, assessments: [], nameVisible: true,
      recoveryGeneration: '1', enforcementCut: hash('policy-cut'),
    })) }) } as unknown as Pool;
  const reader = new DisclosureStore(pool);
  const plain = [target, { ...target, work, workRevision: workHead }];
  for (const inputs of plain.map(input => [input])) {
    await expect(reader.read(inputs, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(reader.readAtCut(inputs, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(reader.readWithAnonymousNames(inputs, ANONYMOUS_VIEWER, 'summary')).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  expect(await reader.read([], ANONYMOUS_VIEWER, 'read')).toEqual([]);
  await expect(reader.read([{ ...target, work: 'unproven' }], ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
  const f = fixture();
  const [selection] = await resolveDisclosureSelections(f.env, [target]);
  await expect(reader.read([{ ...target, ancestry: { ...selection!.ancestry } }], ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
  const unproven = { lineage: f.env.lineage, fuseki: f.env.fuseki } as WorkActivationEnvironment;
  configureDisclosure(unproven, reader);
  configureDisclosureAncestrySource(unproven, 'content', { read: async () => [], reread: async () => [] });
  await expect(disclose(unproven, [{ ...target, work }], ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('disclosure ancestry: zero, one and two positively established parents preserve input order', async () => {
  for (const parents of [
    [],
    [parent('work')],
    [parent('work'), parent('realm')],
  ] as OwnerEstablishedGraphParents[]) {
    const f = fixture(parents);
    if (!parents.some(item => item.kind === 'realm')) f.setEvidence([{ ...evidence(target, parents),
      relationshipBasis: { ...basis(), kind: 'publication' } }]);
    const selections = await resolveDisclosureSelections(f.env, [target]);
    expect(selections).toHaveLength(1);
    expect(selections[0]!.target.resource).toBe(target.resource);
    const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
    expect(cuts[0]!.parents.map((item) => item.kind)).toEqual(parents.map((item) => item.kind));
    expect(cuts[0]!.decision).toBe('visible');
    expect(cuts[0]!.fenceBasis).toEqual({
      recoveryGeneration: '1',
      enforcementCut: hash('fixture-cut-1'),
    });
    expect(
      cuts[0]!.parents.every((item) => item.fenceBasis.enforcementCut === hash('fixture-cut-1')),
    ).toBe(true);
    expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  }
});

test('disclosure ancestry: serialized or copied ancestry cannot become registered owner proof', async () => {
  const f = fixture();
  const [selection] = await resolveDisclosureSelections(f.env, [target]);
  for (const ancestry of [
    JSON.parse(JSON.stringify(selection!.ancestry)),
    { ...selection!.ancestry },
  ]) {
    await expect(
      captureDisclosure(f.env, [{ ...selection!, ancestry }], ANONYMOUS_VIEWER, 'read'),
    ).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  const other = fixture();
  await expect(
    captureDisclosure(other.env, [selection!], ANONYMOUS_VIEWER, 'read'),
  ).rejects.toBeInstanceOf(DisclosureUnavailable);
  await expect(
    captureDisclosure(
      f.env,
      [{ ...selection!, target: { ...target, resource: 'urn:rezics:reply:other' } }],
      ANONYMOUS_VIEWER,
      'read',
    ),
  ).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('disclosure ancestry: incomplete, ambiguous and malformed owner descriptors fail the entire batch', async () => {
  const valid = evidence(target, [parent('work'), parent('realm')]);
  const malformed: unknown[] = [
    [],
    [valid, valid],
    [{ ...valid, status: 'unavailable' }],
    [{ ...valid, resource: 'urn:rezics:reply:other' }],
    [{ ...valid, parents: undefined }],
    [
      {
        ...valid,
        parents: [parent('work'), parent('realm'), { ...parent('realm'), resource: native(10) }],
      },
    ],
    [{ ...valid, parents: [parent('work'), parent('work')] }],
    [{ ...valid, parents: [{ ...parent('realm'), head: '' }] }],
    [{ ...valid, relationshipBasis: { ...basis(), token: 'not-a-sha256' } }],
    [{ ...valid, relationshipBasis: { ...basis(), targetResource: 'urn:rezics:reply:other' } }],
    [
      {
        ...valid,
        relationshipBasis: { ...basis(), targetRevision: 'urn:rezics:content:revision:other' },
      },
    ],
    [
      {
        ...valid,
        parents: [
          {
            ...parent('realm'),
            relationshipBasis: { ...basis(), targetResource: 'urn:rezics:reply:other' },
          },
        ],
      },
    ],
  ];
  for (const rows of malformed) {
    const f = fixture();
    f.setEvidence(rows as DisclosureAncestryEvidence[]);
    await expect(resolveDisclosureSelections(f.env, [target])).rejects.toThrow(
      (rows as unknown[]).length === 1 ? 'Disclosure ancestry is incomplete' : 'Disclosure ancestry result is incomplete',
    );
    expect(f.ownerReads).toHaveLength(0);
  }
});

test('disclosure ancestry: request context and legacy Work hints never substitute for a source or reader', async () => {
  const f = fixture();
  configureDisclosureAncestrySource(f.env, 'graph', { read: async () => [], reread: async () => [] });
  const graphTarget: DisclosureTarget = {
    owner: 'graph',
    resource: native(90),
    component: 'record',
    context: realm,
    work,
    workRevision: workHead,
  };
  await expect(resolveDisclosureSelections(f.env, [graphTarget])).rejects.toBeInstanceOf(
    DisclosureUnavailable,
  );
  configureDisclosure(f.env, null);
  await expect(disclose(f.env, [target], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
    DisclosureUnavailable,
  );
  const legacy = fixture();
  configureDisclosure(legacy.env, { read: async (inputs) => inputs.map(() => 'visible') });
  await expect(captured(legacy)).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('disclosure ancestry: independent publication needs an explicit complete empty proof', async () => {
  const f = fixture([]);
  f.setEvidence([{ ...evidence(target), relationshipBasis: { ...basis(), kind: 'publication' } }]);
  expect((await captured(f))[0]!.decision).toBe('visible');
  // Legacy adapters carry null coordinates for resources with no Work parent.
  const [independent] = await resolveDisclosureSelections(f.env, [
    { ...target, work: null, workRevision: null },
  ]);
  expect(independent!.ancestry.parents).toEqual([]);
  const [nonWorkHead] = await resolveDisclosureSelections(f.env, [
    { ...target, work: null, workRevision: workHead },
  ]);
  expect(nonWorkHead!.ancestry.parents).toEqual([]);
  const workSource = fixture([parent('work')]);
  await expect(resolveDisclosureSelections(workSource.env, [
    { ...target, workRevision: workHead },
  ])).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(f.headQueries).toHaveLength(0);
  f.setEvidence([{ ...evidence(target), status: 'unavailable' }]);
  await expect(resolveDisclosureSelections(f.env, [target])).rejects.toBeInstanceOf(
    DisclosureUnavailable,
  );
});

const requiredParentsByRelationship = {
  identity: [],
  'work-ownership': ['work'],
  'work-in-realm': ['work', 'realm'],
  'realm-placement': ['realm'],
  'realm-selection': ['realm'],
  'realm-module': ['realm'],
  publication: [],
  'media-use': [],
} as const satisfies Record<DisclosureRelationshipBasis['kind'], readonly ('work' | 'realm')[]>;

test.each(Object.entries(requiredParentsByRelationship))(
  'disclosure ancestry: %s rejects every incomplete parent set and accepts complete evidence', async (kind, required) => {
    const sets: OwnerEstablishedGraphParents[] = [[], [parent('work')], [parent('realm')],
      [parent('work'), parent('realm')]];
    for (const parents of sets) {
      const f = fixture(parents);
      f.setEvidence([{ ...evidence(target, parents), relationshipBasis: {
        ...basis(), kind: kind as DisclosureRelationshipBasis['kind'],
      } }]);
      if (required.every(expected => parents.some(parent => parent.kind === expected))) {
        expect((await captured(f))[0]!.decision).toBe('visible');
      } else {
        await expect(captured(f)).rejects.toBeInstanceOf(DisclosureUnavailable);
        expect(f.headQueries).toHaveLength(0);
        expect(f.ownerReads).toHaveLength(0);
      }
    }
  },
);

test('disclosure ancestry: every individual parent basis must establish its required relationship', async () => {
  const unresolvedWork = { ...parent('work'), relationshipBasis: basis() };
  const unresolvedParent = fixture([unresolvedWork]);
  unresolvedParent.setEvidence([{ ...evidence(target, [unresolvedWork]),
    relationshipBasis: { ...basis(), kind: 'publication' } }]);
  // A main publication proof cannot erase the Realm relationship declared by
  // an individual parent basis. Every declared relationship must be complete.
  await expect(captured(unresolvedParent)).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(unresolvedParent.headQueries).toHaveLength(0);
  expect(unresolvedParent.ownerReads).toHaveLength(0);
});

test('disclosure final fence compares only a cut’s established dependencies in a mixed batch', async () => {
  const f = fixture([]);
  const inputs: DisclosureTarget[] = [
    { owner: 'content', resource: work, component: 'body' },
    { owner: 'graph', resource: work, component: 'record' },
  ];
  const rows = inputs.map(input => ({ ...evidence(input),
    resourceKind: input.owner === 'graph' ? 'work' as const : 'other' as const,
    relationshipBasis: { ...basis(input), kind: input.owner === 'graph' ? 'identity' as const : 'publication' as const,
      resource: work, revision: workHead },
  }));
  const source: DisclosureAncestrySource = {
    read: async targets => targets.map(input => rows.find(row => row.relationshipBasis.owner === input.owner)!),
    reread: async bases => bases.map(input => rows.find(row => row.relationshipBasis.owner === input.owner)!),
  };
  for (const owner of ['content', 'graph'] as const) configureDisclosureAncestrySource(f.env, owner, source);
  const cuts = await captureDisclosure(f.env, await resolveDisclosureSelections(f.env, inputs), ANONYMOUS_VIEWER, 'read');
  expect(await fenceDisclosure(f.env, [cuts[0]!], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
});

test('disclosure public batch entries reject over-cap targets before any owner or graph work', async () => {
  for (const entry of [disclose, discloseInventory, discloseInventoryWithCost, discloseInventoryWithAnonymousNames]) {
    const f = fixture();
    let sourceReads = 0;
    configureDisclosureAncestrySource(f.env, 'content', {
      read: async targets => { sourceReads++; return targets.map(input => evidence(input, [parent('realm', input)])); },
      reread: f.source.reread,
    });
    const inputs = Array.from({ length: DISCLOSURE_SUBMISSION_LIMIT + 1 }, () => target);
    await expect(entry(f.env, inputs, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(sourceReads).toBe(0);
    expect(f.headQueries).toHaveLength(0);
    expect(f.ownerReads).toHaveLength(0);
  }
});

for (const size of [65, 501, 512, 1_024, 1_536, 2_048]) {
  test(`public disclosure entries preserve ${size} ordered occurrences across sequential chunks`, async () => {
    const f = fixture();
    const inputs = Array.from({ length: size }, (_, index) => ({ ...target,
      resource: `urn:rezics:reply:public-${index % 70}` }));
    const unique = [...new Map(inputs.map(input => [input.resource, input])).values()];
    f.setEvidence(unique.map(input => evidence(input, [parent('work', input), parent('realm', input)])), unique);
    const expected = inputs.map(input => Number(input.resource.split('-').at(-1)) % 2 ? 'tombstone' : 'visible');
    const chunks: number[] = [];
    const tokenFor = (input: DisclosureTarget) => ({ recoveryGeneration: '1', enforcementCut: hash(input.resource) });
    configureDisclosure(f.env, {
      read: async inputs => inputs.map(() => 'visible'),
      readAtCut: async inputs => {
        chunks.push(inputs.length);
        return { decisions: inputs.map(input => Number(input.resource.split('-').at(-1)) % 2 ? 'tombstone' : 'visible'),
          anonymousNames: inputs.map(() => 'hidden'), fenceBases: inputs.map(tokenFor) };
      },
    });
    const count = Math.ceil(size / 64);
    for (const entry of [disclose, discloseInventory]) {
      chunks.length = 0;
      expect(await entry(f.env, inputs, ANONYMOUS_VIEWER, 'read')).toEqual(expected);
      expect(chunks).toHaveLength(count);
      expect(chunks.every(chunk => chunk <= 64)).toBe(true);
    }
    chunks.length = 0;
    const inventory = await discloseInventoryWithCost(f.env, inputs, ANONYMOUS_VIEWER, 'read');
    expect(inventory.decisions).toEqual(expected);
    expect(inventory.parentHeadQueries).toBe(count);
    expect(inventory.cost.parentHeadQueries).toBe(count);
    expect(chunks).toHaveLength(count);
    chunks.length = 0;
    const names = await discloseInventoryWithAnonymousNames(f.env, inputs, ANONYMOUS_VIEWER, 'read');
    expect(names.decisions).toEqual(expected);
    expect(names.anonymousNames).toEqual(inputs.map(() => 'hidden'));
    expect(chunks).toHaveLength(count);
    const selections = await resolveDisclosureSelections(f.env, inputs);
    expect(selections.map(selection => selection.target.resource)).toEqual(inputs.map(input => input.resource));
    chunks.length = 0;
    const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
    expect(cuts.map(cut => cut.decision)).toEqual(expected);
    expect(cuts.map(cut => cut.fenceBasis)).toEqual(inputs.map(tokenFor));
    expect(chunks).toHaveLength(count);
    chunks.length = 0;
    expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(expected);
    expect(chunks).toHaveLength(count);
    // Subsetting and regrouping cannot replace target-local tokens with a chunk token.
    const subset = [cuts.at(-1)!, cuts[0]!, cuts[64]!, cuts[0]!];
    expect(await fenceDisclosure(f.env, subset, ANONYMOUS_VIEWER, 'read')).toEqual(subset.map(cut => cut.decision));
  });
}

test('resolve, capture, fence and direct owner entries refuse overflow before all work', async () => {
  const f = fixture();
  const selections = await resolveDisclosureSelections(f.env, [target]);
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  let sourceWork = 0;
  configureDisclosureAncestrySource(f.env, 'content', {
    read: async () => { sourceWork++; throw new Error('must not read'); },
    reread: async () => { sourceWork++; throw new Error('must not reread'); },
  });
  f.headQueries.length = 0;
  f.ownerReads.length = 0;
  await expect(resolveDisclosureSelections(f.env, Array(DISCLOSURE_SUBMISSION_LIMIT + 1).fill(target))).rejects.toBeInstanceOf(DisclosureUnavailable);
  await expect(captureDisclosure(f.env, Array(DISCLOSURE_SUBMISSION_LIMIT + 1).fill(selections[0]), ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
  await expect(fenceDisclosure(f.env, Array(DISCLOSURE_SUBMISSION_LIMIT + 1).fill(cuts[0]), ANONYMOUS_VIEWER, 'read'))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
  let statements = 0;
  const reader = new DisclosureStore({ query: async () => { statements++; throw new Error('must not query'); } } as unknown as Pool);
  for (const entry of [reader.read.bind(reader), reader.readWithAnonymousNames.bind(reader), reader.readAtCut.bind(reader)]) {
    await expect(entry(Array(DISCLOSURE_SUBMISSION_LIMIT + 1).fill(target), ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  expect(await reader.readAtCut([], ANONYMOUS_VIEWER, 'read')).toEqual({
    decisions: [], anonymousNames: [], fenceBases: [], cost: {},
  });
  expect(statements).toBe(0);
  expect(sourceWork).toBe(0);
  expect(f.headQueries).toHaveLength(0);
  expect(f.ownerReads).toHaveLength(0);
});

test('strict cut readers refuse missing, incomplete and invalid per-selection bases without a global fallback', async () => {
  for (const fenceBases of [undefined, [], [{ recoveryGeneration: '1', enforcementCut: 'bad' }],
    Array(2).fill({ recoveryGeneration: '1', enforcementCut: hash('cut') })]) {
    const f = fixture();
    configureDisclosure(f.env, { read: f.reader.read, readAtCut: async inputs => ({
      decisions: inputs.map(() => 'visible'), anonymousNames: [], fenceBases,
    }) });
    const selections = await resolveDisclosureSelections(f.env, [target]);
    await expect(captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(disclose(f.env, [target], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
});

test('disclosure ancestry: final fence refuses moved heads, changed placement/review/attachment and owner outage', async () => {
  for (const change of [
    'head',
    'missing-head',
    'placement',
    'review',
    'attachment',
    'epoch',
    'offline',
  ] as const) {
    const f = fixture(),
      cuts = await captured(f);
    if (change === 'head') f.heads.set(realm, native(15));
    else if (change === 'missing-head') f.heads.delete(work);
    else if (change === 'offline') f.setOffline();
    else
      f.setEvidence([
        {
          ...evidence(target, [parent('work'), parent('realm')]),
          relationshipBasis: {
            ...basis(target, change),
            ...(change === 'epoch' ? { dataEpoch: 'restored-epoch' } : {}),
          },
        },
      ]);
    await expect(fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toThrow(
      change === 'head' ? 'Disclosure parent head moved'
        : change === 'missing-head' ? 'Disclosure parent heads are incomplete'
        : change === 'offline' ? 'Disclosure ancestry source is unavailable'
        : change === 'epoch' ? 'Disclosure ancestry is incomplete' : 'Disclosure relationship moved',
    );
  }
});

test('disclosure ancestry: capture refuses evidence whose head is no longer current', async () => {
  const f = fixture();
  const selections = await resolveDisclosureSelections(f.env, [target]);
  f.heads.set(work, native(16));
  await expect(
    captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read'),
  ).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('disclosure ancestry: capture rereads owner proof so a move between resolution and hydration is unavailable', async () => {
  const f = fixture();
  const selections = await resolveDisclosureSelections(f.env, [target]);
  f.setEvidence([
    {
      ...evidence(target, [parent('work'), parent('realm')]),
      relationshipBasis: basis(target, 'moved-before-capture'),
    },
  ]);
  await expect(
    captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read'),
  ).rejects.toThrow('Disclosure relationship moved');
  expect(f.ownerReads).toHaveLength(0);
});

test('disclosure ancestry: paired anonymous name reads use one registered ancestry and Access snapshot', async () => {
  const f = fixture([]);
  const named: DisclosureTarget = {
    owner: 'graph',
    resource: native(20),
    component: 'title',
    revision: native(21),
    nameOwnerResolved: true,
  };
  f.setEvidence([{ ...evidence(named), relationshipBasis: { ...basis(named), kind: 'publication' } }]);
  configureDisclosureAncestrySource(f.env, 'graph', f.source);
  const result = await discloseInventoryWithAnonymousNames(
    f.env,
    [named],
    ANONYMOUS_VIEWER,
    'summary',
  );
  expect(result.decisions).toEqual(['visible']);
  expect(result.anonymousNames).toEqual(['hidden']);
  expect(f.ownerReads).toHaveLength(1);
  expect(f.anonymousFlags).toEqual([true]);
  expect(requireEstablishedAncestry(f.ownerReads[0]![0]!).relationshipBasis.targetResource).toBe(named.resource);
  expect(requireEstablishedAncestry(f.ownerReads[0]![0]!).relationshipBasis.targetRevision).toBe(named.revision);
});

test('disclosure assembly: direct Content keeps Work and Realm ancestry without inventing a Work from resourceId', async () => {
  const f = fixture();
  const revision = '00000000-0000-4000-8000-000000000030';
  const input: DisclosureTarget = {
    owner: 'content',
    resource: realm,
    component: 'body',
    revision,
  };
  f.setEvidence([evidence(input, [parent('work', input), parent('realm', input)])]);
  const row: ExactReadResult = {
    revisionId: revision,
    status: 'available',
    reference: {
      owner: 'content',
      resourceId: realm,
      variantId: 'urn:rezics:variant:fixture',
      revisionId: revision,
      format: 'rezics-content-json-v1',
      model: 'urn:rezics:model:fixture',
      byteDigest: hash('secret'),
      byteLength: 6,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr',
      sourceRevision: null,
      predecessor: null,
      provenance: {},
    },
    serializedJson: '{"secret":"retained bytes"}',
    body: { secret: 'retained bytes' },
  };
  expect(await discloseContent(f.env, [row])).toEqual([row]);
  expect(f.ownerReads[0]![0]!.work).toBeUndefined();
  expect(f.ownerReads[0]![0]!.ancestry!.parents.map((item) => item.resource)).toEqual([
    work,
    realm,
  ]);
  f.setDecisions(['hidden']);
  expect(await discloseContent(f.env, [row])).toEqual([{ revisionId: revision, status: 'denied' }]);
  configureDisclosure(f.env, null);
  await expect(discloseContent(f.env, [row])).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('disclosure assembly: direct media retains use/target ancestry and requires the configured reader', async () => {
  const f = fixture();
  const seen = new Map<string, DisclosureAncestryEvidence>();
  const makeEvidence = (input: DisclosureTarget) => {
    const row = evidence(input, [parent('work', input), parent('realm', input)]);
    seen.set(JSON.stringify(row.relationshipBasis), row);
    return row;
  };
  const source: DisclosureAncestrySource = {
    read: async (inputs) => inputs.map(makeEvidence),
    reread: async (bases) => bases.map((basis) => seen.get(JSON.stringify(basis))!),
  };
  for (const owner of ['media', 'graph'] as const)
    configureDisclosureAncestrySource(f.env, owner, source);
  const bytes = {
    sha256: hash('immutable media bytes'),
    mediaType: 'image/png',
    byteLength: 100,
    availability: 'available',
    clearance: 'cleared',
    owner: native(40),
    uploader: 'fixture-principal',
    disclosure: 'public',
    moderation: 'clear',
    lifecycle: 'active',
    objectNamespace: 'media/',
  };
  const store = disclosureMedia(
    { assetDelivery: async () => bytes } as unknown as MediaStore,
    f.env,
  );
  const asset = native(41).slice(-36);
  expect(await store.assetDelivery(asset, realm, realm)).toEqual(bytes);
  expect(
    f.ownerReads
      .flat()
      .every((input) => input.ancestry!.parents.some((parent) => parent.kind === 'realm')),
  ).toBe(true);
  const blocked = fixture();
  for (const owner of ['media', 'graph'] as const)
    configureDisclosureAncestrySource(blocked.env, owner, source);
  const hiddenReader: DisclosureReader = {
    read: async (inputs) => inputs.map(() => 'hidden'),
    readAtCut: async (inputs) => ({
      decisions: inputs.map(() => 'hidden'),
      anonymousNames: [],
      fenceBases: inputs.map(() => ({ recoveryGeneration: '1', enforcementCut: hash('fixture-cut-1') })),
    }),
  };
  configureDisclosure(blocked.env, hiddenReader);
  const hiddenStore = disclosureMedia(
    { assetDelivery: async () => bytes } as unknown as MediaStore,
    blocked.env,
  );
  expect(await hiddenStore.assetDelivery(asset, realm, realm)).toBeNull();
  configureDisclosure(f.env, null);
  await expect(store.assetDelivery(asset, realm, realm)).rejects.toBeInstanceOf(
    DisclosureUnavailable,
  );
});

test('disclosure assembly: every media delivery refuses an owner selection moved before capture', async () => {
  for (const method of ['assetDelivery', 'avatarDelivery', 'itemDelivery', 'itemDeliveryBatch'] as const) {
    const f = fixture();
    const seen = new Map<string, DisclosureAncestryEvidence>();
    let moved = false;
    const source: DisclosureAncestrySource = {
      read: async inputs => {
        moved = true;
        return inputs.map(input => {
          const row = evidence(input, [parent('work', input), parent('realm', input)]);
          seen.set(JSON.stringify(row.relationshipBasis), row);
          return row;
        });
      },
      reread: async bases => bases.map(item => seen.get(JSON.stringify(item))!),
    };
    for (const owner of ['media', 'graph'] as const) configureDisclosureAncestrySource(f.env, owner, source);
    const use = native(71).slice(-36), asset = native(72).slice(-36);
    const row = { target: realm, context: realm, asset, use, sha256: hash('old selected bytes') };
    const read = async () => {
      const current = moved ? { ...row, sha256: hash('new selected bytes') } : row;
      return method === 'itemDeliveryBatch' ? new Map([[use, current]]) : current;
    };
    const store = disclosureMedia({ [method]: read } as unknown as MediaStore, f.env);
    const delivery = method === 'assetDelivery' ? store.assetDelivery(asset, realm, realm)
      : method === 'avatarDelivery' ? store.avatarDelivery(use)
        : method === 'itemDelivery' ? store.itemDelivery(use) : store.itemDeliveryBatch([use]);
    await expect(delivery).rejects.toThrow('Media delivery selection moved');
  }
});

test('disclosure assembly: batch media preserves owner rows and order while bounding expanded ancestry across capture and fence', async () => {
  const f = fixture();
  const seen = new Map<string, DisclosureAncestryEvidence>();
  const source: DisclosureAncestrySource = {
    read: async inputs => inputs.map(input => {
      const row = evidence(input, [parent('work', input), parent('realm', input)]);
      seen.set(JSON.stringify(row.relationshipBasis), row);
      return row;
    }),
    reread: async bases => bases.map(basis => seen.get(JSON.stringify(basis))!),
  };
  for (const owner of ['media', 'graph'] as const) configureDisclosureAncestrySource(f.env, owner, source);
  const rows: Awaited<ReturnType<MediaStore['itemDeliveryBatch']>> = new Map(
    Array.from({ length: 20 }, (_, index) => [native(100 + index).slice(-36), {
      target: native(200 + index), asset: native(300 + index).slice(-36), representation: native(400 + index).slice(-36),
      role: 'publication-item', crop: null, focalArea: null, anchor: null, sha256: hash(`image-${index}`),
      mediaType: 'image/png', byteLength: 100 + index, width: 20, height: 30,
      availability: 'available', clearance: 'cleared', disclosure: 'public', moderation: 'clear', lifecycle: 'active',
      objectNamespace: 'media/', context: realm,
    }]),
  );
  const requested = [...rows.keys()].reverse();
  let ownerRequest: readonly string[] = [];
  const store = disclosureMedia({ itemDeliveryBatch: async (uses: readonly string[]) => {
    ownerRequest = uses;
    return rows;
  } } as unknown as MediaStore, f.env);
  const delivered = await store.itemDeliveryBatch(requested);
  expect(ownerRequest).toEqual(requested);
  expect([...delivered.keys()]).toEqual([...rows.keys()]);
  for (const [use, row] of rows) expect(delivered.get(use)).toBe(row);
  // Eighty exact asset/use/target assessments keep both parents without
  // treating the policy transport batch as an inventory cap.
  expect(f.ownerReads.map(inputs => inputs.length)).toEqual([64, 16, 64, 16]);
  const captured = f.ownerReads.slice(0, 2).flat();
  expect(captured.map(input => [input.owner, input.resource, input.component])).toEqual(
    [...rows].flatMap(([use, row]) => [
      ['media', `https://rezics.com/id/${row.asset}`, 'cover'],
      ['media', `https://rezics.com/id/${use}`, 'media_use'],
      ['media', row.target, 'media_use'], ['graph', row.target, 'name'],
    ]),
  );
  expect(captured.every(input => input.ancestry!.parents.map(parent => parent.kind).join(',') === 'work,realm')).toBe(true);
  expect(captured.every(input => requireEstablishedAncestry(input).relationshipBasis.targetRevision === null)).toBe(true);

  const hiddenAsset = [...rows.values()][17]!.asset;
  const hiddenReader: DisclosureReader = {
    read: async inputs => inputs.map(() => 'visible'),
    readAtCut: async inputs => ({
      decisions: inputs.map(input => input.resource.endsWith(hiddenAsset) ? 'hidden' : 'visible'),
      anonymousNames: [], fenceBases: inputs.map(() => ({ recoveryGeneration: '1', enforcementCut: hash('fixture-cut-1') })),
    }),
  };
  configureDisclosure(f.env, hiddenReader);
  const filtered = await store.itemDeliveryBatch(requested);
  const deniedUse = [...rows.keys()][17]!;
  expect(filtered.has(deniedUse)).toBe(false);
  expect([...filtered.keys()]).toEqual([...rows.keys()].filter(use => use !== deniedUse));
  for (const [use, row] of filtered) expect(row).toBe(rows.get(use));
});

test('disclosure assembly: nonexistent media and nonavailable Content preserve owner results without disclosure dependencies', async () => {
  const f = fixture();
  const env = { fuseki: f.env.fuseki, lineage: f.env.lineage } as unknown as WorkActivationEnvironment;
  const empty: Awaited<ReturnType<MediaStore['itemDeliveryBatch']>> = new Map();
  const store = disclosureMedia({ itemDelivery: async () => null, itemDeliveryBatch: async () => empty,
    assetDelivery: async () => null, avatarDelivery: async () => null } as unknown as MediaStore, env);
  expect(await store.itemDelivery(native(500).slice(-36))).toBeNull();
  expect(await store.assetDelivery(native(501).slice(-36), realm)).toBeNull();
  expect(await store.avatarDelivery(native(502).slice(-36))).toBeNull();
  expect(await store.itemDeliveryBatch([native(503).slice(-36)])).toBe(empty);
  const nonavailable: ExactReadResult[] = ['denied', 'missing', 'erased', 'unavailable', 'corrupt']
    .map((status, index) => ({ revisionId: native(600 + index).slice(-36),
      status: status as Exclude<ExactReadResult['status'], 'available'> }));
  expect(await discloseContent(env, nonavailable)).toEqual(nonavailable);
  expect(await discloseContent(env, [])).toEqual([]);
  expect(f.ownerReads).toHaveLength(0);
  expect(f.headQueries).toHaveLength(0);
});

test('disclosure ancestry: changed Access cut discards visible hydration even when current policy becomes hidden', async () => {
  for (const change of [
    { recoveryGeneration: '2', enforcementCut: hash('fixture-cut-1') },
    { recoveryGeneration: '1', enforcementCut: hash('fixture-cut-2') },
  ]) {
    const f = fixture(),
      cuts = await captured(f);
    f.setFence(change);
    await expect(fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
    f.setDecisions(['hidden']);
    await expect(fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
});

test('disclosure ancestry: incomplete policy result and absent Access basis cannot yield visible', async () => {
  const f = fixture();
  f.setDecisions([]);
  await expect(captured(f)).rejects.toBeInstanceOf(DisclosureUnavailable);
  const missing = fixture();
  missing.setFence({ recoveryGeneration: '', enforcementCut: '' });
  await expect(captured(missing)).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('disclosure ancestry: a hidden capture never becomes visible after an incomplete final reread', async () => {
  const f = fixture();
  f.setDecisions(['hidden']);
  const cuts = await captured(f);
  f.setOffline();
  try {
    expect(await fenceDisclosure(f.env, cuts, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
  } catch (error) {
    expect(error).toBeInstanceOf(DisclosureUnavailable);
  }
});

test('disclosure ancestry: chunks bound 128 parent edges and inventory reports measured head queries', async () => {
  const f = fixture();
  const inputs = Array.from({ length: 64 }, (_, index): DisclosureTarget => ({
    ...target,
    resource: `urn:rezics:reply:batch-${index}`,
  }));
  f.heads.clear();
  f.setEvidence(
    inputs.map((input, index) => {
      const parents = [parent('work', input), parent('realm', input)].map((item, ordinal) => ({
        ...item,
        resource: native(100 + index * 2 + ordinal),
        head: native(1000 + index * 2 + ordinal),
      }));
      for (const item of parents) f.heads.set(item.resource, item.head);
      return evidence(input, parents as unknown as OwnerEstablishedGraphParents);
    }), inputs,
  );
  const selections = await resolveDisclosureSelections(f.env, inputs);
  expect(selections.map((selection) => selection.target.resource)).toEqual(
    inputs.map((input) => input.resource),
  );
  const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read');
  expect(cuts).toHaveLength(64);
  expect(cuts.flatMap((cut) => cut.parents)).toHaveLength(128);
  expect(DISCLOSURE_COST.graphParents).toBe(2);
  expect(DISCLOSURE_COST.parentEdges).toBe(128);
  expect(DISCLOSURE_COST.parentHeadBatch).toBe(64);
  expect(f.headQueries).toHaveLength(2);
  const before = f.headQueries.length;
  const inventory = await discloseInventoryWithCost(f.env, inputs, ANONYMOUS_VIEWER, 'read');
  expect(inventory.parentHeadQueries).toBe(2);
  expect(inventory.parentHeadQueries).toBe(f.headQueries.length - before);
  for (const query of f.headQueries) {
    const values = query.match(/VALUES\s+\?resource\s*\{([^}]+)\}/i)?.[1];
    expect(values).toBeDefined();
    expect(values!.match(/<https:\/\/rezics\.com\/id\//g)!.length).toBeLessThanOrEqual(64);
  }
  expect(await resolveDisclosureSelections(f.env, [...inputs, inputs[0]!])).toHaveLength(65);
  expect(await captureDisclosure(f.env, [...selections, selections[0]!], ANONYMOUS_VIEWER, 'read')).toHaveLength(65);
});
