import type { FakeRoute } from '../fake-modules';
import { traversalSubjects } from './edition-work';

const catalogueSubjects = new Set<string>(Object.values(traversalSubjects).map((subject) => subject.id));

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request }) => {
      const agent = new URL(request.url).searchParams.get('agent');
      if (!agent || !catalogueSubjects.has(agent)) return;
      // These catalogue fixtures have no verified account. Do not inherit the generic Mira recording.
      return { status: 200, accounts: [], next: null };
    },
  },
];
