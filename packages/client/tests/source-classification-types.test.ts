import { expect, test } from 'bun:test';
import type { ClientKernel } from '../src/kernel/http/kernel.ts';
import type {
  SourceClassificationBatchInput,
  SourceClassificationBatch,
  SourceClassificationPutInput,
  SourceClassificationPutResult,
  SourceClassificationClearInput,
  SourceClassificationClearResult,
} from '../src/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Mounted = ClientKernel['~Routes']['v1']['subjects'][':id'];
type Transport<T> = T extends { 'source-classifications': infer Methods } ? Methods : never;
type Method<T, Verb extends string> = T extends Record<Verb, { post: infer Declaration }> ? Declaration : never;
type Body<T> = T extends { body: infer Input } ? Input : never;
type Result<T> = T extends { response: { 200: infer Output } } ? Output : never;
type Read = Method<Transport<Mounted>, '$read'>;
type Put = Method<Transport<Mounted>, '$put'>;
type Clear = Method<Transport<Mounted>, '$clear'>;
const closure: [
  Assert<Equal<SourceClassificationBatchInput, Body<Read>>>,
  Assert<Equal<SourceClassificationBatch, Result<Read>>>,
  Assert<Equal<SourceClassificationPutInput, Body<Put>>>,
  Assert<Equal<SourceClassificationPutResult, Result<Put>>>,
  Assert<Equal<SourceClassificationClearInput, Body<Clear>>>,
  Assert<Equal<SourceClassificationClearResult, Result<Clear>>>,
] = [true, true, true, true, true, true];

test('official classification DTO aliases follow installed mounted declarations', () => {
  // This pins declaration closure, not the presence of an installed publication.
  expect(closure).toEqual([true, true, true, true, true, true]);
});
