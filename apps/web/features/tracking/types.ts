import type { MainClient } from '../discover/types.ts';

// Main's tracking reads and writes, taken from the typed Eden client so a
// contract change breaks this build: attempts are `/v1/me/sessions` (G-834),
// series progress and the edition preference `/v1/me/progress-summaries` and
// `/v1/me/edition-preferences` (G-835), editions the Work's own lists (G-833).
type Me = MainClient['v1']['me'];
type Work = ReturnType<MainClient['v1']['works']>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Body<Call> = Call extends (body: infer Input, ...args: never[]) => unknown ? NonNullable<Input> : never;

export type SessionPage = Ok<Me['sessions']['get']>;
export type Session = SessionPage['items'][number];
export type SessionState = Session['state'];
export type Selection = Session['selections'][number];
export type Locator = Session['locators'][number];
export type LocatorUnit = Locator['unit'];
export type SessionCreate = Body<Me['sessions']['post']>;
export type SessionChanges = Omit<SessionCreate, 'actingSubject' | 'expectedVersion' | 'target'>;
export type SelectionInput = NonNullable<SessionChanges['addSelections']>[number];

export type SeriesSummary = Ok<ReturnType<Me['progress-summaries']>['get']>;
export type SeriesPart = SeriesSummary['completedParts'][number];
export type EditionPreference = NonNullable<Ok<ReturnType<Me['edition-preferences']>['get']>>;
export type EditionChoice = Pick<EditionPreference, 'language' | 'edition'>;
export type Realization = Ok<Work['realizations']['get']>['items'][number];
export type Release = Ok<Work['releases']['get']>['items'][number];
export type Relations = Ok<ReturnType<MainClient['v1']['resources']>['relations']['get']>;

/** The Work's own realizations and releases: what an attempt can name besides the Work itself. */
export interface Editions { realizations: Realization[]; releases: Release[]; more: boolean }
