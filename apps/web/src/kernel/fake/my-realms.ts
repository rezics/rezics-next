import type { FakeRoute } from '../fake-modules';

/** A recorded native page supplies the same current projection to fake-kernel consumers. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/me/realms',
    story: ({ recordings }) => {
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
