import { expect, test } from 'bun:test';
import type {
  Kernel,
  SourceStatistic,
  SourceStatisticClearInput,
  SourceStatisticClearResult,
  SourceStatisticFigures,
  SourceStatisticListResponse,
  SourceStatisticWriteInput,
  SourceStatisticWriteResult,
} from '../src/index.ts';

type Mounted = Kernel['~Routes']['v1']['subjects'][':id']['source-statistics'];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const routes: Assert<
  Equal<
    [
      SourceStatisticListResponse,
      SourceStatistic,
      SourceStatisticWriteInput,
      SourceStatisticWriteResult,
      SourceStatisticClearInput,
      SourceStatisticClearResult,
    ],
    [
      Mounted['get']['response'][200],
      Mounted['get']['response'][200][number],
      Mounted[':source']['put']['body'],
      Mounted[':source']['put']['response'][200],
      Mounted[':source']['$clear']['post']['body'],
      Mounted[':source']['$clear']['post']['response'][204],
    ]
  >
> = true;
const figures: Assert<
  Equal<[SourceStatistic['source'], SourceStatisticFigures['schemaVersion']], ['vndb' | 'bangumi', 1]>
> = true;

test('source statistic aliases follow the mounted API declaration', () => {
  expect([routes, figures]).toEqual([true, true]);
});
