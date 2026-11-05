import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import type { CollectionSourceObservation } from '../../src/library/collection-source.ts';
import type { NativeSourceIdentity } from '../../src/library/native-source-custody.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { compileCurrentOwnerFilter } from '../../src/search/current-filter-plan.ts';
import { evaluateScopeSubjects, ScopeWork, scopeAllowance } from '../../src/search/scope-execution.ts';
import type { ScopeBasis } from '../../src/search/scope-source.ts';

test('scope basis has exclusive real indexed and native owner source branches', () => {
  type Native = Extract<ScopeBasis, { nativeOwner: unknown }>;
  type Indexed = Extract<ScopeBasis, { generation: number }>;
  expectTypeOf<Native['nativeOwner']>().toEqualTypeOf<
    Readonly<{
      source: NativeSourceIdentity;
      observation: CollectionSourceObservation;
    }>
  >();
  expectTypeOf<Native['generation']>().toEqualTypeOf<undefined>();
  expectTypeOf<Native['index']>().toEqualTypeOf<undefined>();
  expectTypeOf<Indexed['generation']>().toEqualTypeOf<number>();
  expectTypeOf<Indexed['index']>().toEqualTypeOf<string>();
  expectTypeOf<Indexed['nativeOwner']>().toEqualTypeOf<undefined>();
});

test('shared native evaluator cannot replace missing owner evidence with a Boolean branch', async () => {
  const plan = compileCurrentOwnerFilter({
    or: [{ owner: { presence: true } }, { not: { owner: { presence: true } } }],
  });
  const work = new ScopeWork(scopeAllowance(16, 'native-owner-evidence'));
  const result = await evaluateScopeSubjects({
    // These dependencies must remain unused when actual native owner authority is absent.
    get pool(): Pool {
      throw new Error('No native evidence was supplied');
    },
    get options(): LeafOptions {
      throw new Error('No reader authority was supplied');
    },
    plan,
    basis: 'native-owner',
    subjects: ['subject'],
    work,
    reservation: { rawKeys: 16, native: { points: 16, witnesses: 16, rows: 16, bytes: 8192, emptySeeks: 16 } },
  });
  expect(result.values).toEqual(['not_proven']);
  expect(result.evidence).toEqual([]);
  expect(result.progress).toBeNull();
  expect(work.receipt().used.candidateKeys).toBe(0);
});
