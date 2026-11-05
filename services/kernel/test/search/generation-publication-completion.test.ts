import { expect, test } from 'bun:test';
import type {
  NativePublicFilterPublication,
  NativePublicFilterPublicationCompletion,
} from '../../src/semantic/public-filter-source-binding.ts';
import { isVerifiedNativeGenerationPublicationCompletion } from '../../src/search/generation-publication.ts';

const start = { observation: '0:original-cut' };
const publication = {
  job: '00000000-0000-4000-8000-000000000001',
  bootstrap: '0:00000000-0000-4000-8000-000000000001',
  queried: {
    consumer: { physicalTarget: 'subjects-g2', incarnation: 'incarnation' },
    snapshot: { kind: 'pit', observation: '0:original-observation', pit: 'original-pit' },
  },
  execution: '00000000-0000-4000-8000-000000000001',
} as unknown as NativePublicFilterPublication;

function completion(observation: Record<string, unknown>): NativePublicFilterPublicationCompletion {
  return {
    status: 'complete',
    publication,
    definition: {},
    covered: start,
    execution: { id: publication.execution, start, ownRows: [] },
    observation,
    terminal: { step: 'terminal-step', root: 'terminal-root' },
    settlement: { id: 'settlement' },
    cost: {
      inputKeys: 0,
      candidates: 0,
      accessPoints: 0,
      dependencyPoints: 0,
      engineSearches: 0,
      engineIteratorSteps: 0,
      outputSlots: 0,
      resultWrites: 0,
      frontierWrites: 0,
    },
  } as unknown as NativePublicFilterPublicationCompletion;
}

test('historical changed disclosure facts do not block verified generation maintenance', () => {
  const changed = [{ partition: 7, epoch: 3, position: 91n }];
  const result = completion({
    status: 'observed',
    coverage: 'all_native_homes',
    routingComplete: true,
    unacknowledged: [],
    changed,
    blocking: [],
  });

  expect(isVerifiedNativeGenerationPublicationCompletion(result, publication, start)).toBe(true);
  expect(
    (result as Extract<NativePublicFilterPublicationCompletion, { status: 'complete' }>).observation.changed,
  ).toEqual(changed);
});

test('generation maintenance still requires a complete Source result and the exact original execution', () => {
  const incomplete = {
    status: 'pending',
    publication,
    reason: 'owner_unavailable',
    cost: {
      inputKeys: 0,
      candidates: 0,
      accessPoints: 0,
      dependencyPoints: 0,
      engineSearches: 0,
      engineIteratorSteps: 0,
      outputSlots: 0,
      resultWrites: 0,
      frontierWrites: 0,
    },
  } as unknown as NativePublicFilterPublicationCompletion;
  const wrongExecution = completion({
    status: 'observed',
    coverage: 'all_native_homes',
    routingComplete: true,
    unacknowledged: [],
    changed: [],
    blocking: [],
  });

  expect(isVerifiedNativeGenerationPublicationCompletion(incomplete, publication, start)).toBe(false);
  expect(
    isVerifiedNativeGenerationPublicationCompletion(
      wrongExecution,
      { ...publication, execution: '00000000-0000-4000-8000-000000000002' },
      start,
    ),
  ).toBe(false);
});
