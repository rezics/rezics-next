import { expect, test } from 'bun:test';
import type { ClientKernel } from '../src/kernel/http/kernel.ts';
import type {
  ClassificationBallotOwnPage,
  ClassificationBallotOwnPageItem,
  ClassificationBallotOwnPageQuery,
} from '../src/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Mounted = ClientKernel['~Routes']['v1']['me']['classification-assessments']['get'];
type MountedPage = Mounted['response'][200];
const publication: [
  Assert<Equal<ClassificationBallotOwnPageQuery, Mounted['query']>>,
  Assert<Equal<ClassificationBallotOwnPage, MountedPage>>,
  Assert<Equal<ClassificationBallotOwnPageItem, MountedPage['items'][number]>>,
] = [true, true, true];

test('own assessment aliases follow the installed mounted declaration', () => {
  expect(publication).toEqual([true, true, true]);
});
