import { expect, test } from 'bun:test';
import type { ClientKernel } from '../src/kernel/http/kernel.ts';
import type { KernelClient } from '../src/index.ts';
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
type AssertPresent<T> = [T] extends [never] ? false : true;
type State<T> = T extends { state: infer Value } ? Value : never;
type RootTransport = Transport<ReturnType<KernelClient['subjects']>>;
type Read = Method<Transport<Mounted>, '$read'>;
type Put = Method<Transport<Mounted>, '$put'>;
type Clear = Method<Transport<Mounted>, '$clear'>;
type RootRead = Method<RootTransport, '$read'>;
type RootPut = Method<RootTransport, '$put'>;
type RootClear = Method<RootTransport, '$clear'>;
const closure: [
  Assert<AssertPresent<Read>>,
  Assert<AssertPresent<Put>>,
  Assert<AssertPresent<Clear>>,
  Assert<Equal<SourceClassificationBatchInput, Body<Read>>>,
  Assert<Equal<SourceClassificationBatch, Result<Read>>>,
  Assert<Equal<SourceClassificationPutInput, Body<Put>>>,
  Assert<Equal<SourceClassificationPutResult, Result<Put>>>,
  Assert<Equal<SourceClassificationClearInput, Body<Clear>>>,
  Assert<Equal<SourceClassificationClearResult, Result<Clear>>>,
  Assert<Equal<RootRead, Read>>,
  Assert<Equal<RootPut, Put>>,
  Assert<Equal<RootClear, Clear>>,
  Assert<Equal<State<SourceClassificationPutResult>, 'published' | 'cleared'>>,
  Assert<Equal<State<SourceClassificationClearResult>, 'published' | 'cleared'>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];

test('official classification DTO aliases follow installed mounted declarations', () => {
  expect(closure).toEqual(Array(closure.length).fill(true));
});
