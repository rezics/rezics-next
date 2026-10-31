import { expect, test } from 'bun:test';
import { verifyPublicFilterRepairSourcePage } from '../../src/search/public-filter-custody-source.ts';
import type {
  NativeSourceRepairLocator,
  NativeSourceRepairStepRead,
  PublicFilterRepairSourceBinding,
  RetainedRepairPage,
  RetainedSourceRepair,
} from '../../src/search/public-filter-custody-contract.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { PublicSourceRepair } from '../../src/semantic/public-filter-source-binding.ts';

// Isolated port-composition tests. These values never establish native Source/engine proof.
const cost: PublicFilterCost = {
  inputKeys: 1,
  candidates: 1,
  accessPoints: 1,
  dependencyPoints: 1,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};
const context = () => ({ deadline: Date.now() + 10_000 });
const request: NativeSourceRepairStepRead = {
  bootstrap: '0:original-bootstrap',
  execution: 'original-execution',
  predecessor: 'prior-step',
  queried: {
    snapshot: { kind: 'pit', observation: '0:old-observation', pit: 'old-pit' },
    consumer: {
      physicalTarget: 'subjects-g1',
      incarnation: 'original-uuid',
      consumerGeneration: 'generation',
      projectionGeneration: 'projection',
      meaningDigest: 'meaning',
      readDefinition: 'definition',
    },
  },
};
const locator = (digest: string): NativeSourceRepairLocator => ({
  bootstrap: request.bootstrap,
  execution: request.execution,
  step: 'native-step',
  locatorDigest: digest,
});
const repair = (digest: string): RetainedSourceRepair => {
  const source = {
    subject: 'subject',
    terminal: 'subject',
    partition: 1,
    epoch: 1,
    position: 9n,
    revision: 1,
    securityRevision: 'revision',
    currentRelease: 'meaning',
  };
  return {
    kind: 'foreign',
    locator: { subject: 'subject', slot: 'slot', candidate: digest, property: 'schema:author', dependencies: [] },
    source,
    projection: {
      status: 'complete',
      source,
      records: [],
      repairLocators: [],
      frontier: { build: 'original-build', generation: 1n, continuation: 'original-page' },
      requiredHeads: [],
      cost,
    },
    receipt: locator(digest),
  };
};
const page = (repairs: readonly RetainedSourceRepair[] = []): RetainedRepairPage => ({
  sourceStep: 'native-step',
  predecessor: request.predecessor,
  complete: true,
  frontier: null,
  repairs,
});
function port(expected: RetainedRepairPage, trace: string[] = []): PublicFilterRepairSourceBinding {
  return {
    async resolve() {
      return { status: 'unavailable', reason: 'owner_unavailable', cost };
    },
    async join() {
      return { status: 'unavailable', reason: 'owner_unavailable', cost };
    },
    async readRepairStep(input) {
      trace.push('step');
      expect(input).toEqual(request);
      return {
        status: 'verified',
        step: expected.sourceStep,
        predecessor: expected.predecessor,
        complete: expected.complete,
        frontier: expected.frontier,
        receipts: expected.repairs.map((item) => item.receipt),
        cost,
      };
    },
    async readRepairReceipt(input) {
      trace.push(input.receipt.locatorDigest);
      expect(input.queried).toEqual(request.queried);
      expect(input.execution).toBe(request.execution);
      return {
        status: 'verified',
        repair: expected.repairs.find(
          (item) => item.receipt.locatorDigest === input.receipt.locatorDigest,
        )! as unknown as PublicSourceRepair,
        cost,
      };
    },
  };
}

test('empty final closure requires the exact owner step and charges its actual work without an item receipt', async () => {
  const expected = page();
  const trace: string[] = [];
  const costs: PublicFilterCost[] = [];
  expect(
    await verifyPublicFilterRepairSourcePage(port(expected, trace), request, expected, context(), (next) => {
      if (next) costs.push(next);
    }),
  ).toEqual(expected);
  expect(trace).toEqual(['step']);
  expect(costs).toEqual([cost]);
  const unavailable = {
    ...port(expected),
    async readRepairStep() {
      return {
        status: 'unavailable' as const,
        reason: 'owner_unavailable' as const,
        cost,
      };
    },
  };
  await expect(verifyPublicFilterRepairSourcePage(unavailable, request, expected, context(), () => {})).rejects.toThrow(
    'owner_unavailable',
  );
  await expect(
    verifyPublicFilterRepairSourcePage({} as PublicFilterRepairSourceBinding, request, expected, context(), () => {}),
  ).rejects.toThrow('owner_unavailable');
});

test('ordered original item locators and actual verified repair bodies are required on replay', async () => {
  const expected = page([repair('first'), repair('second')]);
  const trace: string[] = [];
  const costs: PublicFilterCost[] = [];
  expect(
    await verifyPublicFilterRepairSourcePage(port(expected, trace), request, expected, context(), (next) => {
      if (next) costs.push(next);
    }),
  ).toEqual(expected);
  expect(trace).toEqual(['step', 'first', 'second']);
  expect(costs).toEqual([cost, cost, cost]);
  const reordered = { ...expected, repairs: [...expected.repairs].reverse() };
  await expect(
    verifyPublicFilterRepairSourcePage(port(reordered), request, expected, context(), () => {}),
  ).rejects.toThrow('binding_mismatch');
  const changed = {
    ...port(expected),
    async readRepairReceipt() {
      return {
        status: 'verified' as const,
        repair: { ...repair('first'), kind: 'local' } as unknown as PublicSourceRepair,
        cost,
      };
    },
  };
  await expect(verifyPublicFilterRepairSourcePage(changed, request, expected, context(), () => {})).rejects.toThrow(
    'binding_mismatch',
  );
  const missing = {
    ...expected,
    repairs: [{ ...repair('first'), receipt: {} as NativeSourceRepairLocator }],
  };
  await expect(
    verifyPublicFilterRepairSourcePage(port(expected), request, missing, context(), () => {}),
  ).rejects.toThrow('owner_unavailable');
});

test('original repair body survives different replay accounting while actual verification work is charged', async () => {
  const original = repair('first');
  const expected = page([original]);
  const replayCost = { ...cost, inputKeys: 3, candidates: 4 };
  const verified = {
    ...port(expected),
    async readRepairReceipt() {
      return {
        status: 'verified' as const,
        repair: {
          ...original,
          projection: { ...original.projection, cost: replayCost },
        } as unknown as PublicSourceRepair,
        cost: replayCost,
      };
    },
  };
  const charged: PublicFilterCost[] = [];
  expect(
    await verifyPublicFilterRepairSourcePage(verified, request, expected, context(), (next) => {
      if (next) charged.push(next);
    }),
  ).toEqual(expected);
  expect(charged).toEqual([cost, replayCost]);
  const changed = {
    ...verified,
    async readRepairReceipt() {
      const result = await verified.readRepairReceipt();
      return {
        ...result,
        repair: {
          ...result.repair,
          projection: { ...result.repair.projection, frontier: null },
        } as unknown as PublicSourceRepair,
      };
    },
  };
  await expect(verifyPublicFilterRepairSourcePage(changed, request, expected, context(), () => {})).rejects.toThrow(
    'binding_mismatch',
  );
});

test('owner uncertainty, a replaced cut, wrong predecessor and unfinished frontier remain unavailable', async () => {
  const expected = page([repair('first')]);
  const uncertain = {
    ...port(expected),
    async readRepairReceipt() {
      return {
        status: 'unavailable' as const,
        reason: 'owner_unavailable' as const,
        cost,
      };
    },
  };
  await expect(verifyPublicFilterRepairSourcePage(uncertain, request, expected, context(), () => {})).rejects.toThrow(
    'owner_unavailable',
  );
  for (const changed of [
    { ...expected, predecessor: 'later-predecessor' },
    { ...expected, frontier: 'unfinished' },
    {
      ...expected,
      repairs: [
        {
          ...repair('first'),
          receipt: { ...locator('first'), bootstrap: '0:new-bootstrap' },
        },
      ],
    },
  ]) {
    await expect(
      verifyPublicFilterRepairSourcePage(port(changed), request, expected, context(), () => {}),
    ).rejects.toThrow('binding_mismatch');
  }
});

test('the original allowance admits each owner call and stops before another item when exhausted', async () => {
  const expected = page([repair('first'), repair('second')]);
  const trace: string[] = [];
  let keys = 998;
  await expect(
    verifyPublicFilterRepairSourcePage(port(expected, trace), request, expected, context(), (next) => {
      keys += next?.inputKeys ?? 0;
      if (keys >= 1000) throw new Error('original allowance exhausted');
    }),
  ).rejects.toThrow('original allowance exhausted');
  expect(trace).toEqual(['step', 'first']);
});
