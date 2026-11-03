import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { parse } from 'valibot';
import { PageStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { searchLoaderDeps, searchParams } from '../search/search-params';

const meta = {
  title: 'Pages/Community/Realm Catalogue Navigation',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The default routed Space page, with its current Realm identity, participation, catalogue entry, boards and editorial publications. Existing recorded sources supply the page; long-name and unreadable-Realm variants prepare explicit response changes. Plays are authored assertions, not rendered or native evidence. Rating discovery opens ordinary scoped Search because RealmHome supplies no admitted rating populations or readiness. Browser and visual inspection are deferred to integration.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-member" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function catalogue(canvasElement: HTMLElement) {
  await pageReady({ canvasElement });
  return within(canvasElement).findByRole('region', { name: m.realm_catalogue_heading() });
}

async function inspectEntry({ canvasElement }: { canvasElement: HTMLElement }) {
  const region = await catalogue(canvasElement);
  const view = within(region);
  const browse = view.getByRole('link', { name: m.realm_catalogue_browse() });
  const ratings = view.getByRole('link', { name: m.realm_catalogue_ratings_entry() });
  const url = new URL(browse.getAttribute('href')!, location.origin);
  const deps = searchLoaderDeps(parse(searchParams, Object.fromEntries(url.searchParams)));
  await expect(url.pathname).toBe(`/${getLocale()}/search`);
  await expect(deps.resourceScope?.kind).toBe('realm');
  await expect(deps.ratingPopulation).toBeUndefined();
  await expect(deps.cursor).toBeUndefined();
  await expect(ratings).toHaveAttribute('href', browse.getAttribute('href'));
  await expect(view.getByText(m.realm_catalogue_ratings_context())).toBeVisible();
  await expect(within(canvasElement).getByText(m.realm_catalogue_publications_context())).toBeVisible();
  await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  for (const element of [browse, ratings, view.getByRole('button', { name: m.realm_catalogue_query_entry() })]) {
    await expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  browse.focus();
  await userEvent.tab();
  const expand = view.getByRole('button', { name: m.realm_catalogue_query_entry() });
  await expect(expand).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await userEvent.tab();
  const query = view.getByRole('searchbox', { name: m.realm_catalogue_query_label() });
  await expect(query).toHaveFocus();
  await userEvent.type(query, '雪 & slow reading');
  const form = region.querySelector('form')!;
  const fields = Object.fromEntries(new FormData(form));
  const entered = searchLoaderDeps(parse(searchParams, fields));
  await expect(entered.query).toBe('雪 & slow reading');
  await expect(entered.resourceScope).toEqual(deps.resourceScope);
  await expect(entered.ratingPopulation).toBeUndefined();
  await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  await userEvent.click(view.getByRole('button', { name: m.realm_catalogue_query_clear() }));
  await expect(query).toHaveValue('');
  await expect(query).toHaveFocus();
}

export const PhoneLight: Story = {
  name: 'Phone 390 · light · complete visit',
  globals: { theme: 'light', viewport: { value: 'phone390', isRotated: false } },
  play: inspectEntry,
};
export const PhoneDark: Story = {
  name: 'Phone 390 · dark · complete visit',
  globals: { theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
  play: inspectEntry,
};
export const DesktopLight: Story = {
  name: 'Desktop 1280 · light · complete visit',
  globals: { theme: 'light', viewport: { value: 'desktop1280', isRotated: false } },
  play: inspectEntry,
};
export const DesktopDark: Story = {
  name: 'Desktop 1280 · dark · complete visit',
  globals: { theme: 'dark', viewport: { value: 'desktop1280', isRotated: false } },
  play: inspectEntry,
};

export const EmptyQuery: Story = {
  name: 'Empty query retains Realm membership',
  globals: { theme: 'light', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const region = await catalogue(canvasElement);
    const view = within(region);
    await userEvent.click(view.getByRole('button', { name: m.realm_catalogue_query_entry() }));
    const form = region.querySelector('form')!;
    const deps = searchLoaderDeps(parse(searchParams, Object.fromEntries(new FormData(form))));
    await expect(deps.query).toBe('');
    await expect(deps.resourceScope?.kind).toBe('realm');
    await expect(view.getByRole('button', { name: m.realm_catalogue_query_submit() })).toBeEnabled();
    await expect(view.getByRole('searchbox')).toHaveValue('');
  },
};

export const OversizedQuery: Story = {
  name: 'Multibyte overflow keeps the previous draft',
  globals: { theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const view = within(await catalogue(canvasElement));
    await userEvent.click(view.getByRole('button', { name: m.realm_catalogue_query_entry() }));
    const field = view.getByRole('searchbox');
    await userEvent.click(field);
    await userEvent.paste('界'.repeat(171));
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(view.getByRole('alert')).toHaveTextContent(m.realm_catalogue_query_overflow());
    await expect(view.getByRole('button', { name: m.realm_catalogue_query_submit() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.realm_catalogue_query_clear() }));
    await expect(field).toHaveFocus();
    await expect(view.getByRole('button', { name: m.realm_catalogue_query_submit() })).toBeEnabled();
  },
};

const longName = `A community for readers across languages — ${'UnbrokenCommunityName'.repeat(30)}`;
function preparedSource(state: 'long' | 'unreadable') {
  return () => {
    const previous = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'http://kernel.local' || request.method !== 'GET') return previous(input, init);
      if (state === 'unreadable' && /^\/v1\/realms\/[^/]+$/.test(url.pathname))
        return Response.json({ code: 'not_found' }, { status: 404 });
      const response = await previous(input, init);
      if (state !== 'long' || !response.ok || !url.pathname.startsWith('/v1/realms/')) return response;
      const body = await response.clone().json();
      if (body.realm) body.realm.title = longName;
      if (body.community) body.community.name = longName;
      return Response.json(body, { status: response.status, headers: response.headers });
    }, { preconnect: previous.preconnect }) as typeof fetch;
    return () => { globalThis.fetch = previous; };
  };
}

export const LongLocalizedName: Story = {
  name: 'Long community name · German · phone',
  beforeEach: preparedSource('long'),
  globals: { locale: 'de', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
  play: async (context) => {
    await inspectEntry(context);
    const region = await catalogue(context.canvasElement);
    await expect(region.textContent).toContain(longName);
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  },
};

export const UnreadableRealm: Story = {
  name: 'Space with no readable Realm',
  beforeEach: preparedSource('unreadable'),
  globals: { theme: 'light', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const region = await catalogue(canvasElement);
    await expect(within(region).getByText(m.realm_catalogue_unavailable())).toBeVisible();
    await expect(region.querySelector('a, form, input')).toBeNull();
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  },
};
