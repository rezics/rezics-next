/** The whole-Work mark, stored as one progress row whose structure and occurrence
 * are both the Work. A partless Work has no Structure placement to complete, and
 * a Work cannot contain itself, so inventing an occurrence would be a second
 * identity. Library shelves and reading attempts stay their own records: a
 * finished or abandoned attempt cannot be undone in place, and abandoning one
 * clears the shelf. This row is the mark the part panels already use
 * (`completed`, `position`, expected version), addressed at the Work.
 *
 * `started` is playing or reading: one meaning, two words. `dropped` is abandoned.
 * Completed is the boolean with no position. Not started is an empty or cleared row. */

export const workStandings = ['not-started', 'started', 'completed', 'dropped'] as const;
export type WorkStanding = (typeof workStandings)[number];

export class WorkHasParts extends Error {}

export function encodeWorkStanding(standing: WorkStanding): { completed: boolean; position: string | null } {
  switch (standing) {
    case 'not-started': return { completed: false, position: null };
    case 'started': return { completed: false, position: 'started' };
    case 'completed': return { completed: true, position: null };
    case 'dropped': return { completed: false, position: 'dropped' };
  }
}

/** Null when the row is not one of the four marks, so a caller does not flatten it. */
export function decodeWorkStanding(row: { completed: boolean; position: string | null }): WorkStanding | null {
  if (row.completed && row.position === null) return 'completed';
  if (!row.completed && row.position === null) return 'not-started';
  if (!row.completed && row.position === 'started') return 'started';
  if (!row.completed && row.position === 'dropped') return 'dropped';
  return null;
}
