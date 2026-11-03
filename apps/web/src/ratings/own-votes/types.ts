import type { Static } from 'typebox';

type NativeOwnVotesPageSchema = typeof import('../../../../../services/kernel/src/rating/own-votes-schemas.ts').OwnVotesPageSchema;
type NativeOwnVoteActionsSchema = typeof import('../../../../../services/kernel/src/rating/own-votes-schemas.ts').OwnVoteActionsSchema;

export type OwnVotesPage = Static<NativeOwnVotesPageSchema>;
export type OwnVoteEntry = OwnVotesPage['votes'][number];
export type OwnVoteActions = Static<NativeOwnVoteActionsSchema>;
