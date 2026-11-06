import { expect, test } from 'bun:test';
import { createNativeAccessPorts } from '../../src/access/adapters/native.ts';
import {
  collectionKindPreparationNativeWork,
  observeAccountErasureSearch,
} from '../../src/search/access-capabilities.ts';

test('Access native ports receive Search collection-kind work and erasure observation', () => {
  const ports = createNativeAccessPorts();
  expect(typeof ports.kindAudience.collectionKindPreparationNativeWork).toBe('function');
  expect(typeof ports.searchErasure?.observeAccountErasureSearch).toBe('function');
  expect(typeof collectionKindPreparationNativeWork).toBe('function');
  expect(typeof observeAccountErasureSearch).toBe('function');
});
