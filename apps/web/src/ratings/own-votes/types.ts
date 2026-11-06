import type { KernelClient } from '@rezics/client';

/** Successful page shape from the installed generated `GET /v1/me/rating-votes` operation. */
export type OwnVotesPage = NonNullable<Awaited<ReturnType<KernelClient['me']['rating-votes']['get']>>['data']>;
export type OwnVoteEntry = OwnVotesPage['votes'][number];
export type OwnVoteActions = OwnVoteEntry['actions'];
