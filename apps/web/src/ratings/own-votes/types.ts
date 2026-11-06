import type { OwnVotesPage as NativeOwnVotesPage } from '@rezics/client';

export type OwnVotesPage = NativeOwnVotesPage;
export type OwnVoteEntry = OwnVotesPage['votes'][number];
export type OwnVoteActions = OwnVoteEntry['actions'];
