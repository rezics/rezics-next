import type { FakeRoute } from '../fake-modules';

let unavailableEditionId: string | null = null;

export function setEntitlementReaderUnavailableEditionId(id: string): void {
  unavailableEditionId = id;
}

export function resetEntitlementReaderUnavailable(): void {
  unavailableEditionId = null;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/contentEditions\/([^/]+)(?:\/revision)?$/,
    story: ({ match }) =>
      match?.[1] === unavailableEditionId && unavailableEditionId !== null
        ? { status: 503, code: 'dependency_unavailable' }
        : undefined,
  },
];
