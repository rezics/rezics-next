import { communityPeople } from './community-plan.ts';
import { people } from './plan.ts';

const names = new Map([...people, ...communityPeople].map(person => [person.id, person.name]));

/** Display name of a plan person. Session ids are those people. */
export const personName = (id: string): string | undefined => names.get(id);
