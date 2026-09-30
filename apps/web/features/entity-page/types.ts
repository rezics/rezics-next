import type { MainClient } from '../discover/types.ts';

// Main's `entity-page-v1` projection and the section reads it links, taken from
// the typed Eden client so a contract change breaks this build.
type Resource = ReturnType<MainClient['v1']['resources']>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;

export type EntityProjection = Ok<Resource['page']['get']>;
export type EntitySection = EntityProjection['sections'][number];
export type SectionId = EntitySection['id'];
export type TargetBase = EntityProjection['target']['base'];
export type StatementPage = Ok<Resource['statements']['get']>;
export type StatementGroup = StatementPage['groups'][number];
export type StatementItem = StatementGroup['items'][number];
export type { RelationsPage } from '../work-levels/types.ts';

/** What a link from an entity page points at: another resource, or another page of a list on this one. */
export type EntityLink =
  | { kind: 'resource'; iri: string; base: TargetBase | null; type: string | null }
  | { kind: 'continue'; section: SectionId; cursor: string | null };

/**
 * Maps every link an entity page draws to an address. The standalone route
 * sends Works to their `/w` host and everything else to `/e`; a Zone sends them
 * to its own routes, so a detail page never leaves its site.
 */
export type HrefFor = (link: EntityLink) => string;
