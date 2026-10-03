import type { MainClient } from '../discover/types.ts';

// Main's read responses for Work levels, taken from the typed Eden client so a
// contract change breaks this build. `parts` and `wholes` are G-830, `relations`
// G-831, releases and realizations G-833 (`services/main/src/routes`).
type Main = MainClient;
type Resource = ReturnType<Main['v1']['resources']>;
type Work = ReturnType<Main['v1']['works']>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;

export type PartsPage = Ok<Resource['parts']['get']>;
export type Part = PartsPage['parts'][number];
export type WholesPage = Ok<Resource['wholes']['get']>;
export type Whole = WholesPage['wholes'][number];
export type RelationsPage = Ok<Resource['relations']['get']>;
export type RelationEntry = RelationsPage['items'][number];
export type RelationRendering = NonNullable<RelationEntry['rendering']>;
export type RelationProjection = RelationRendering['projections'][number];
export type RelationBinding = RelationRendering['bindings'][number];
export type Summary = Ok<Main['v1']['resources']['summaries']['post']>['summaries'][number];
export type AvailableSummary = Extract<Summary, { status: 'available' }>;
export type ReleasePage = Ok<Work['releases']['get']>;
export type Release = ReleasePage['items'][number];
export type ReleaseCoverage = Release['coverage'][number];
export type RealizationPage = Ok<Work['realizations']['get']>;
export type Realization = RealizationPage['items'][number];

/** One member of a Collection's selected structure: a Work placed in a franchise. */
export interface CollectionMember {
  occurrence: string; role: string; parent: string; target?: string; orderKey: string;
  labels: { value: string; language: string }[];
}
export interface CollectionMembers { collection: string; members: CollectionMember[]; next: string | null }

/** A name Main selected for the reader, in the shape `LocalizedText` takes. */
export interface NameText { value: string; language: string; direction: 'ltr' | 'rtl' }

export type { Loaded, ReadFailure } from '../work-page/types.ts';

/** Contributors by Agent IRI, as the profile link needs them: the public name and the handle. */
export type People = ReadonlyMap<string, { name: string; handle: string | null }>;

/** Names by resource IRI, from Main's summary batch; absent when Main did not answer for it. */
export type Names = ReadonlyMap<string, Summary>;
