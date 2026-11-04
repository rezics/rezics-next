import { expect, test } from 'bun:test';
import {
  isMembershipOperation,
  membershipProfile,
  newMembershipCommand,
  parseMembershipPage,
  readMembershipCommand,
  saveMembershipCommand,
  submitMembership,
} from '../src/organization-membership';

const human = '00000000-0000-4000-8000-000000000001';
const organization = '00000000-0000-4000-8000-000000000002';
const member = '00000000-0000-4000-8000-000000000003';
const identity = { id: member, kind: 'actor', handle: 'reader', displayName: 'Rae Reader' };
const detail = {
  organizationId: organization,
  viewer: { accountId: human, role: 'owner', leave: 'unavailable' },
  members: {
    state: 'ready',
    items: [
      { accountId: member, account: identity, role: 'member', actions: { changeRole: 'allowed', remove: 'allowed' } },
    ],
    next: 'bounded-next',
  },
};

test('Manage native organization membership with fresh approved commands preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  // These are page-adapter assertions, not native authority/workflow proof.
  // The declared native/served acceptance remains integration debt.
  const page = parseMembershipPage(detail, organization, human);
  expect(page).toEqual({
    kind: 'ready',
    organizationId: organization,
    viewer: { accountId: human, role: 'owner', leave: 'unavailable' },
    members: {
      state: 'ready',
      holders: [
        { accountId: member, account: identity, role: 'member', actions: { changeRole: 'allowed', remove: 'allowed' } },
      ],
      next: 'bounded-next',
    },
  });
  expect(parseMembershipPage(detail, human, member).kind).toBe('unavailable');
  expect(parseMembershipPage({ ...detail, members: { state: 'denied' } }, organization, human).kind).toBe(
    'unavailable',
  );
  expect(
    isMembershipOperation({ kind: 'membership', organizationId: organization, memberAccountId: member, role: null }),
  ).toBe(false);
  expect(
    isMembershipOperation({
      kind: 'membership',
      organizationId: organization,
      memberAccountId: member,
      role: 'administrator',
    }),
  ).toBe(false);
  expect(
    isMembershipOperation({
      kind: 'membership',
      organizationId: organization,
      memberAccountId: member,
      role: 'member',
      principal: organization,
    }),
  ).toBe(false);
  const command = newMembershipCommand(human, {
    kind: 'membership',
    organizationId: organization,
    memberAccountId: member,
    role: 'owner',
  });
  expect(Object.isFrozen(command.operation)).toBe(true);
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ account_id: member, client_id: 'login', scope: [] });
  }) as typeof fetch;
  try {
    expect(saveMembershipCommand(command)).toBe(true);
    expect(readMembershipCommand()).toEqual(command);
    expect(await submitMembership(command)).toBe('denied');
    expect(requests).toEqual(['/session']);
    expect(readMembershipCommand()).toEqual(command);
    command.reference = 'native-approval';
    command.unresolved = true;
    expect(saveMembershipCommand(command)).toBe(true);
    const recovered = readMembershipCommand();
    expect(recovered).toEqual(command);
    if (!recovered || recovered === 'invalid') throw new Error('Missing exact retry');
    expect(recovered.operationKey).toBe(command.operationKey);
    expect(recovered.reference).toBe('native-approval');
    expect(recovered.unresolved).toBe(true);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('management profile accepts only the shared separate exact membership scope', () => {
  expect(membershipProfile({})).toBeNull();
  expect(
    membershipProfile({
      AUTH_PAGE_MANAGEMENT_CLIENT_ID: 'management',
      AUTH_PAGE_MANAGEMENT_SCOPES: { membership: ['organization:membership', 'account:manage'] },
    }),
  ).toBeNull();
  expect(
    membershipProfile({
      AUTH_PAGE_MANAGEMENT_CLIENT_ID: 'management',
      AUTH_PAGE_MANAGEMENT_SCOPES: { membership: ['organization:membership'] },
    }),
  ).toEqual({ client_id: 'management', scope: ['organization:membership'] });
});

test('member pages reject malformed, duplicated, oversized and foreign native observations', () => {
  expect(parseMembershipPage({}, organization, human).kind).toBe('unavailable');
  expect(
    parseMembershipPage(
      { ...detail, members: { ...detail.members, items: Array(21).fill(detail.members.items[0]) } },
      organization,
      human,
    ).kind,
  ).toBe('unavailable');
  expect(
    parseMembershipPage(
      { ...detail, members: { ...detail.members, items: [detail.members.items[0], detail.members.items[0]] } },
      organization,
      human,
    ).kind,
  ).toBe('unavailable');
  expect(
    parseMembershipPage(
      {
        ...detail,
        members: {
          ...detail.members,
          items: [{ ...detail.members.items[0], account: { ...identity, id: human, email: 'private@example.test' } }],
        },
      },
      organization,
      human,
    ).kind,
  ).toBe('unavailable');
  expect(
    parseMembershipPage(
      { ...detail, viewer: { accountId: human, role: 'member', leave: 'last-owner' } },
      organization,
      human,
    ).kind,
  ).toBe('unavailable');
});
