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
