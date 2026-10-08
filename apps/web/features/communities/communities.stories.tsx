import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { realmHref } from '../realm/route.ts';
import { CreateCommunityForm } from './create-form.tsx';

const meta = {
  title: 'Communities/Create community',
  component: CreateCommunityForm,
  parameters: { route: { pathname: '/en/r/new' } },
  args: { actingSubject: 'https://rezics.com/id/00000000-0000-8000-8000-000000000412', locale: 'en' },
} satisfies Meta<typeof CreateCommunityForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewCommunity: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Community name' }), 'Readers Circle');
    await userEvent.type(canvas.getByRole('textbox', { name: /Community handle/ }), 'readers-circle');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Description' }), 'Discuss favorite books together.');
    await userEvent.click(canvas.getByRole('button', { name: 'Add a translation' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Translation language' }), 'zh-Hans');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Translated name' }), '读书圈');
    // No language is assumed from the interface; the author states it.
    await expect(canvas.getByRole('button', { name: 'Name language: Language not specified' })).toBeVisible();
    await userEvent.click(canvas.getByRole('radio', { name: /Restricted/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add a rule' }));
    await expect(canvas.getByRole('textbox', { name: 'Rule title' })).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Rule title' }), 'Be kind');
    await userEvent.type(canvas.getByRole('textbox', { name: 'What does this rule mean?' }), 'Respect every reader.');
    await expect(canvas.getByText('Anyone can read. You decide who can join and post.')).toBeVisible();
  },
};

export const Chinese: Story = { args: { locale: 'zh-Hans' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: '社区名称' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '创建社区' })).toBeVisible();
  } };

const createdRealm = '00000000-0000-8000-8000-000000000436';
const createdNavigation = fn();

/** The completed owner writes navigate to the community's short identity address. */
export const CreatedCommunityAddress: Story = {
  parameters: { route: { pathname: '/en/r/new', onPush: createdNavigation } },
  beforeEach() {
    createdNavigation.mockClear();
    const original = window.fetch;
    const storageKey = `rezics:community-setup:${meta.args.actingSubject}:https://rezics.com/id/${createdRealm}`;
    const previous = localStorage.getItem(storageKey);
    window.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.origin);
      if (!url.pathname.startsWith('/api/main/')) return original(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.pathname === '/api/main/v1/spaces' && method === 'POST')
        return Response.json({ realm: `https://rezics.com/id/${createdRealm}` });
      const base = `/api/main/v1/realms/${createdRealm}`;
      if (url.pathname === `${base}/management` && method === 'POST') return Response.json({});
      if (url.pathname === `${base}/settings` && method === 'GET')
        return Response.json({ settings: {}, generation: '0', ruleBasis: { revision: null } });
      if ([`${base}/settings`, `${base}/profile`].includes(url.pathname) && method === 'PUT')
        return Response.json({});
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    return () => {
      window.fetch = original;
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    };
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Community name' }), 'Readers Circle');
    await userEvent.type(canvas.getByRole('textbox', { name: /Community handle/ }), 'readers-circle');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Description' }), 'Discuss books together.');
    await userEvent.click(canvas.getByRole('button', { name: 'Create community' }));
    await waitFor(() => expect(createdNavigation).toHaveBeenCalledWith(realmHref('en', createdRealm)));
    if (import.meta.env.VITE_G1002_CAPTURE === '1') {
      const { page } = await import('vitest/browser');
      await document.fonts.ready;
      await page.screenshot({ path: '../../../../.temp/g-1002-created-community.png' });
    }
  },
};

const problem = (status: number, code: string) => Response.json({
  type: `https://rezics.com/problems/${code}`, title: code, status, code,
}, { status, headers: { 'content-type': 'application/problem+json' } });

function mockMain(decide: (url: URL, method: string) => Response | null) {
  const original = window.fetch;
  window.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.origin);
    if (!url.pathname.startsWith('/api/main/')) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return decide(url, method) ?? new Response(null, { status: 503 });
  }) as typeof fetch;
  return () => { window.fetch = original; };
}

async function submitReaders(canvas: ReturnType<typeof within>) {
  await userEvent.type(canvas.getByRole('textbox', { name: 'Community name' }), 'Readers Circle');
  await userEvent.type(canvas.getByRole('textbox', { name: /Community handle/ }), 'readers-circle');
  await userEvent.type(canvas.getByRole('textbox', { name: 'Description' }), 'Discuss books together.');
  await userEvent.click(canvas.getByRole('radio', { name: /Restricted/ }));
  await userEvent.click(canvas.getByRole('button', { name: 'Create community' }));
}

const ownedRealm = `https://rezics.com/id/${createdRealm}`;

/** A lost response leaves the handle taken by the founder's own Realm. The
 * address resolves and the managed list names it, so the form opens it. */
export const RecoveredOwnRealm: Story = {
  parameters: { route: { pathname: '/en/r/new', onPush: createdNavigation } },
  beforeEach() {
    createdNavigation.mockClear();
    return mockMain((url, method) => {
      if (url.pathname === '/api/main/v1/spaces' && method === 'POST')
        return problem(409, 'alias_conflict');
      if (url.pathname === '/api/main/v1/addresses/resolve' && method === 'GET')
        return Response.json({ profile: 'address-resolution-v1', scope: 'space', key: 'readers-circle',
          status: 'resolved', capabilities: { realm: ownedRealm } });
      if (url.pathname === '/api/main/v1/me/managed-realms' && method === 'GET')
        return Response.json({ items: [{ realm: ownedRealm, permissions: ['realm.owner'],
          openCount: { value: 0, kind: 'exact' }, escalatedCount: { value: 0, kind: 'exact' },
          latestActivity: null }], nextCursor: null, complete: true });
      if (url.pathname === `/api/main/v1/realms/${createdRealm}/profile` && method === 'PUT')
        return problem(404, 'realm_unavailable');
      return null;
    });
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await submitReaders(canvas);
    await waitFor(() => expect(createdNavigation).toHaveBeenCalledWith(realmHref('en', createdRealm)));
  },
};

/** A handle that resolves to a Realm this founder does not manage is taken.
 * The other Realm's identity is not shown. */
export const SomeoneElsesHandle: Story = {
  parameters: { route: { pathname: '/en/r/new', onPush: createdNavigation } },
  beforeEach() {
    createdNavigation.mockClear();
    const other = '00000000-0000-8000-8000-000000000999';
    return mockMain((url, method) => {
      if (url.pathname === '/api/main/v1/spaces' && method === 'POST')
        return problem(409, 'alias_conflict');
      if (url.pathname === '/api/main/v1/addresses/resolve' && method === 'GET')
        return Response.json({ profile: 'address-resolution-v1', scope: 'space', key: 'readers-circle',
          status: 'resolved', capabilities: { realm: `https://rezics.com/id/${other}` } });
      if (url.pathname === '/api/main/v1/me/managed-realms' && method === 'GET')
        return Response.json({ items: [], nextCursor: null, complete: true });
      return null;
    });
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await submitReaders(canvas);
    await waitFor(() => expect(canvas.getByRole('alert').textContent ?? '').toContain('This handle is already taken'));
    await expect(createdNavigation).not.toHaveBeenCalled();
    await expect(canvasElement.textContent ?? '').not.toContain('00000000-0000-8000-8000-000000000999');
  },
};
