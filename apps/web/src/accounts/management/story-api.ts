import type { FakeRoute } from '../../kernel/fake-modules';
import type { Detail, Inventory } from './data';

// Illustrative API responses for page review. These are not native authority or served-journey evidence.
export const human = {
  id: '01a1a000-0000-7000-8000-000000000101',
  kind: 'actor' as const,
  handle: 'avery',
  displayName: 'Avery Reader',
};
export const organization = {
  id: '01a1a000-0000-7000-8000-000000000102',
  kind: 'organization' as const,
  handle: 'atlas-editors',
  displayName: 'Atlas Editors',
};
export const automation = {
  id: '01a1a000-0000-7000-8000-000000000103',
  kind: 'actor' as const,
  handle: 'atlas-indexer',
  displayName: 'Atlas Indexer',
};
const reservationId = '01a1a000-0000-7000-8000-000000000104';
type Mode =
  | 'populated'
  | 'empty'
  | 'long'
  | 'preparing'
  | 'denied'
  | 'unavailable'
  | 'member'
  | 'missing'
  | 'handleless';
let mode: Mode = 'populated';
export function selectManagementStory(next: Mode) {
  mode = next;
}
export function inventoryExample(): Inventory {
  return {
    account: human,
    viewer: { state: 'current', account: human },
    organizations: {
      state: 'ready',
      items: [{ account: organization, role: 'owner', navigation: { state: 'admitted' } }],
      next: null,
    },
    responsibilities: {
      items: [
        {
          account: automation,
          accountId: automation.id,
          reservationId,
          state: 'current',
          navigation: { state: 'admitted' },
        },
        {
          account: null,
          accountId: '01a1a000-0000-7000-8000-000000000105',
          reservationId: '01a1a000-0000-7000-8000-000000000106',
          state: 'reconciling',
          navigation: { state: 'concealed' },
        },
      ],
      next: null,
    },
  };
}
export function detailExample(accountId: string): Detail {
  const isOrganization = accountId === organization.id;
  const self = accountId === human.id;
  return {
    account: isOrganization ? organization : self ? human : automation,
    self,
    role: isOrganization ? 'owner' : null,
    operator: !isOrganization && !self ? organization : null,
    relation: !isOrganization && !self ? { operatorAccountId: organization.id, reservationId, version: '2' } : null,
    members: {
      state: 'ready',
      items: isOrganization ? [{ accountId: human.id, account: human, role: 'owner' }] : [],
      next: null,
    },
    responsibilities: isOrganization || self ? inventoryExample().responsibilities : null,
  };
}
function refusal() {
  if (mode === 'denied') return { status: 403, code: 'forbidden' };
  if (mode === 'unavailable') return { status: 503, code: 'dependency_unavailable' };
  if (mode === 'missing') return { status: 404, code: 'not_found' };
}
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/me/managedAccounts',
    story: () => {
      const error = refusal();
      if (error) return error;
      const value = inventoryExample();
      if (mode === 'empty' || mode === 'preparing') {
        value.organizations = { state: mode === 'preparing' ? 'preparing' : 'ready', items: [], next: null };
        value.responsibilities = { items: [], next: null };
      }
      if (mode === 'long') {
        value.organizations.items = [
          {
            account: {
              ...organization,
              displayName:
                'The International Association for Carefully Maintained Independent Bibliographic Archives and Editorial Collections',
            },
            role: 'owner',
            navigation: { state: 'admitted' },
          },
        ];
        value.organizations.next = 'illustrative-organization-continuation';
      }
      return { status: 200, ...value };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/accounts\/([^/]+)\/management$/,
    story: ({ match }) => {
      const error = refusal();
      if (error) return error;
      const value = detailExample(match![1]!);
      if (mode === 'member') {
        value.role = 'member';
        value.members = { state: 'denied', items: [], next: null };
        value.responsibilities = null;
      }
      if (mode === 'handleless') {
        value.account = { ...value.account, handle: null, displayName: null };
      }
      if (mode === 'long') {
        value.account = {
          ...value.account,
          displayName:
            'The International Association for Carefully Maintained Independent Bibliographic Archives and Editorial Collections',
        };
      }
      if (mode === 'empty') {
        value.members.items = [];
        value.responsibilities = { items: [], next: null };
      }
      return { status: 200, ...value };
    },
  },
];
