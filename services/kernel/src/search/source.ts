import { partitionOf, routeOf } from '../route/route.ts';

export type LanguageValue = { language: string; value: string };
export type IndexedSubject = {
  id: string;
  type: string;
  /** Only visible subjects are indexed. */
  visibility: 'visible' | 'hidden' | 'taken_down';
  /** The survivor when this subject was merged away; a redirected subject is not indexed. */
  redirect: string | null;
  /** Advanced, never reused, by every change that hides or takes down the subject or one of its facts. */
  securityRevision: number;
  labels: LanguageValue[];
  aliases: LanguageValue[];
  descriptions: LanguageValue[];
  /** Adopted Global statement values; an item value is the target subject id. */
  statements: { property: string; value: string }[];
};

/** The partition's `core.partition.position` and the listed subjects' state, read in one snapshot. */
export type SubjectSnapshot = { partition: number; position: bigint; subjects: IndexedSubject[] };

export interface SubjectSource {
  /** Unknown ids are omitted. Every id must route to `partition`. */
  read(partition: number, ids: readonly string[]): Promise<SubjectSnapshot>;
  /** Visible, non-redirected subjects of the partition and its position, in one snapshot. */
  count(partition: number): Promise<{ position: bigint; count: number }>;
}

/** Returns the partition selected by the route in UUID bytes 10–11. */
export function subjectPartition(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Subject id must be a routable UUID');
  return partitionOf(route);
}
