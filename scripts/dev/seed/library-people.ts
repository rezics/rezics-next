import { communityPeople } from './community-plan.ts';
import { people } from './plan.ts';
import type { Session } from './state.ts';

const names = new Map([...people, ...communityPeople].map(person => [person.id, person.name]));

/** The plan's demo people. `state.sessions` also holds helper accounts that later steps sign in, such as the
 * scoped-subject raters; they have no shelf, follows or votes of the demo's own. */
export function demoSessions<T extends Pick<Session, 'id'>>(sessions: readonly T[]): T[] {
  return sessions.filter(session => names.has(session.id));
}

export const personName = (id: string): string | undefined => names.get(id);
