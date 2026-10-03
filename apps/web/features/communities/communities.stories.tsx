import type { Meta, StoryObj } from '@storybook/react-vite';
import { uuidToSid } from '@rezics/model/address';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
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
    // ast-grep-ignore: web-links-use-address-tsx -- Independent expected path guards the post-creation redirect without reusing its builder.
    await waitFor(() => expect(createdNavigation).toHaveBeenCalledWith(`/en/r/${uuidToSid(createdRealm)}`));
    if (import.meta.env.VITE_G1002_CAPTURE === '1') {
      const { page } = await import('vitest/browser');
      await document.fonts.ready;
      await page.screenshot({ path: '../../../../.temp/g-1002-created-community.png' });
    }
  },
};
