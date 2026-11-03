import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type {
  OwnCountedVoteObservation,
  OwnCountedVotePreparation,
  OwnCountedVotePrepareResult,
  OwnCountedVoteReader,
  OwnCountedVoteReadResult,
  OwnCountedVoteRequest,
  OwnCountedVoteResult,
} from '../src/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// Workspace typecheck resolves these through the installed generated module and public root.
const prepare: Assert<Equal<OwnCountedVoteReader['prepare'],
  (request: OwnCountedVoteRequest, deadline: number) => Promise<OwnCountedVotePrepareResult>>> = true;
const read: Assert<Equal<OwnCountedVoteReader['read'],
  (client: Pick<PoolClient, 'query'>, request: OwnCountedVoteRequest,
   preparation: OwnCountedVotePreparation) => Promise<OwnCountedVoteReadResult>>> = true;
const finish: Assert<Equal<OwnCountedVoteReader['finish'],
  (request: OwnCountedVoteRequest, preparation: OwnCountedVotePreparation,
   result: OwnCountedVoteReadResult, deadline: number) => Promise<OwnCountedVoteResult>>> = true;
const states: Assert<Equal<OwnCountedVoteObservation['state'], 'counted' | 'clear' | 'absent' | 'unavailable'>> = true;

test('public counted reader signatures and observation states typecheck through installed declarations', () => {
  expect([prepare, read, finish, states]).toEqual([true, true, true, true]);
});
