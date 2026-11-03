import { expect, expectTypeOf, test } from 'bun:test';
import {
  type KernelClient,
  type OwnVoteActions,
  type OwnVoteEntry,
  type OwnVotesPage,
  type OwnVotesPageQuery,
} from '../src/index.ts';

type ExpectedActions =
  | { state: 'editable'; clear: string; readback: string; put: string }
  | { state: 'retired'; clear: string; readback: string; reason: 'question_retired' }
  | { state: 'unavailable'; reason: 'merged_source' | 'identity_pending' | 'read_only' };

const typedRequest = async (client: KernelClient) => {
  const response = await client.me['rating-votes'].get({ query: { cursor: 'next' } });
  if (response.error) throw response.error;
  expectTypeOf(response.data).toEqualTypeOf<OwnVotesPage>();
};

test('my ratings uses the mounted page types and closed actions', () => {
  expect(typeof typedRequest).toBe('function');
  expectTypeOf<OwnVotesPageQuery>().toEqualTypeOf<{ cursor?: string }>();
  expectTypeOf<OwnVoteEntry>().toEqualTypeOf<OwnVotesPage['votes'][number]>();
  expectTypeOf<OwnVoteActions>().toEqualTypeOf<ExpectedActions>();
});
