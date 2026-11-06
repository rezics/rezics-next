import { expect, test } from 'bun:test';
import {
  classifyGenerationCoverage,
  decodeGenerationPublicationPin,
  decodeGenerationPublicationQueried,
  decodeGenerationProofValue,
  encodeGenerationPublicationPin,
  encodeGenerationPublicationQueried,
  encodeGenerationProofValue,
  publicationPinFromNative,
  sameGenerationPublicationPin,
} from '../../src/search/generation-publication-pin.ts';
import { searchPageRecoveryTransition } from '../../src/search/page-recovery.ts';

const queried = {
  consumer: {
    physicalTarget: 'demo-subjects-g2',
    incarnation: 'uuid',
    consumerGeneration: '2',
    projectionGeneration: '2',
    meaningDigest: 'digest',
    readDefinition: 'definition',
  },
  snapshot: { kind: 'prepared' as const, observation: 'obs', build: 'build', generation: 9n },
};

test('publication pins retain scalar, bigint and undefined meaning across restart', () => {
  const pin = publicationPinFromNative({
    job: '11111111-1111-4111-8111-111111111111',
    bootstrap: '22222222-2222-4222-8222-222222222222',
    queried,
    execution: 'execution-1',
  });
  const encoded = encodeGenerationPublicationPin(pin);
  const decoded = decodeGenerationPublicationPin(encoded);
  expect(decoded.queried.snapshot.kind).toBe('prepared');
  if (decoded.queried.snapshot.kind !== 'prepared') throw new Error('pin lost prepared generation');
  expect(decoded.queried.snapshot.generation).toBe(9n);
  expect(sameGenerationPublicationPin(pin, decoded)).toBe(true);
  const retained = decodeGenerationPublicationQueried(encodeGenerationPublicationQueried(queried));
  expect(retained.snapshot.kind).toBe('prepared');
  if (retained.snapshot.kind !== 'prepared') throw new Error('queried column lost prepared generation');
  expect(retained.snapshot.generation).toBe(9n);
  expect(encodeGenerationProofValue({ count: undefined, extra: 3n, label: 'ok' })).not.toBe(
    encodeGenerationProofValue({ extra: 3n, label: 'ok' }),
  );
  expect(decodeGenerationProofValue(encodeGenerationProofValue({ count: undefined, extra: 3n }))).toEqual({
    count: undefined,
    extra: 3n,
  });
});

test('identity, body and version coverage names missing Source keys and extra engine keys', () => {
  expect(classifyGenerationCoverage(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({
    matched: ['b', 'c'],
    missing: ['a'],
    extra: ['d'],
  });
});

test('changed generation or identity restarts; destination return restores the executed page', () => {
  expect(searchPageRecoveryTransition({ generationChanged: true })).toBe('restart');
  expect(searchPageRecoveryTransition({ identityChanged: true })).toBe('restart');
  expect(searchPageRecoveryTransition({ preparing: true })).toBe('preparing');
  expect(searchPageRecoveryTransition({ returning: true })).toBe('destination-return');
  expect(searchPageRecoveryTransition({})).toBe('ready');
});
