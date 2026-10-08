import type { Loaded, MainClient, ReadFailure } from '../feed/types.ts';

// The editorial review shapes of G-865 (`services/main/src/routes/editorial-proposals.ts`),
// taken from the typed Eden client so a contract change breaks this build.

export type { Loaded, MainClient, ReadFailure };
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Proposals = MainClient['v1']['editorial']['proposals'];
type One = ReturnType<Proposals>;

export type ProposalRead = Ok<One['get']>;
export type ProposalPage = Ok<Proposals['get']>;
export type ProposalSummary = ProposalPage['items'][number];
export type ProposalFilter = NonNullable<Parameters<Proposals['get']>[0]>['query']['filter'];
export type CommandResult = Ok<Proposals['post']>;
export type Blocker = ProposalRead['blockers'][number];
export type AllowedAction = ProposalRead['allowedActions'][number];
export type ProposalState = ProposalRead['state'];
export type Evidence = ProposalRead['revision']['evidence'][number];
export type BaseHead = ProposalRead['revision']['baseHeads'][number];
export type Change = ProposalRead['preview'][number];
export type TimelineEntry = ProposalRead['timeline'][number];
export type ReviewOutcome = 'approve' | 'request_changes' | 'comment';

/** A Work's header as the propose form edits it: Main's `work-metadata` header state. */
export interface LocalizedFacts { language: string; title: string | null; description: string | null;
  mainVersionLabel: string | null; tagline?: string | null }
export interface HeaderState { kind: 'header'; originalTitle: { value: string; language: string } | null;
  completionStatus?: 'ongoing' | 'completed' | 'hiatus' | 'upcoming' | 'cancelled' | null; localized: LocalizedFacts[] }

/** What a correction names: the exact resource revision and the component heads it was written against. */
export interface CorrectionBasis {
  target: { resource: string; revision: string; context: string };
  baseHeads: BaseHead[];
  state: HeaderState;
  /** The Work's name, for the dialog's title. */
  name: { value: string; language: string } | null;
}

/** A name for a target: its text and language for `lang`. */
export interface TargetName { value: string; language: string; direction?: 'ltr' | 'rtl' }

export const GLOBAL_CONTEXT = 'urn:rezics:context:global';

/** The UUID at the end of a REZICS IRI, as Main's path parameters take it. */
export const uuidOf = (iri: string) => iri.slice(-36);
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
