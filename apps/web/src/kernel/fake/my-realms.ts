import type { FakeRoute } from '../fake-modules';
import { interfaceInventory } from './realm-home-interface';

/** A recorded native page supplies the same current projection to fake-kernel consumers. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/me/realms',
    story: ({ request, recordings }) => {
      const supplied = interfaceInventory(new URL(request.url).searchParams.get('cursor'));
      if (supplied) return { status: 200, ...supplied };
      const response = recordings['my-realms'];
      if (!response || !Array.isArray(response.items)) return;
      return response;
    },
    fixture: ({ recordings }) => {
      const response = recordings['my-realms'];
      if (!response || !Array.isArray(response.items)) return;
      return response;
    },
  },
];
