import type { SubjectRead as Read } from '@rezics/client';

export type Subject = Read['subject'];
export type Related = Read['related'] &
  Record<
    string,
    Read['related'][string] & {
      /** The kernel type will carry the survivor id for merged subjects. */
      redirect?: string;
    }
  >;

/** The cover summary the kernel returns with a subject read. */
export type Summary = NonNullable<Read['summary']>;

/** The display groups of the Relations view, in the order the page shows them; `other` holds what has no group yet. */
export const RELATION_GROUPS = ['order', 'derivation', 'world', 'membership', 'association', 'other'] as const;
export type RelationGroup = (typeof RELATION_GROUPS)[number];

/** How one relation property reads from the page subject's side of the inverse read. */
export type RelationDefinition = {
  label: string;
  forwardLabel?: string;
  /** Inert reader presentation; semantic property labels and identities retain their own meaning. */
  readerLabel?: string;
  forwardReaderLabel?: string;
  group: RelationGroup;
  symmetric: boolean;
};
