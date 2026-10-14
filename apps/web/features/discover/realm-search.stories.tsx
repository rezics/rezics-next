import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { browserMainApi } from '../api/browser.ts';
import { Providers } from '../shell/providers.tsx';
import { discoveryApi, type ListPage, type ResourceCard } from './api.ts';
import { readBrowse, type BrowseResult } from './browse-read.ts';
import { browseMessages } from './browse-messages.ts';
import { DiscoverView } from './discover-view.tsx';
import { realmSearchFixture, type RealmSearchState } from './realm-search-fixtures.ts';

function RealmSearch({ kind, persona, loading = false }: { kind: RealmSearchState; persona: AnswerPersona; loading?: boolean }) {
  const fixture = realmSearchFixture(kind);
  const [result, setResult] = useState<BrowseResult<ListPage<ResourceCard>> | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    if (loading) return () => { active = false; };
    const main = browserMainApi('https://contract.invalid', { anonymous: persona === 'visitor',
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname !== '/api/main/v1/query' || request.method !== 'POST'
          || JSON.stringify(await request.json()) !== JSON.stringify(fixture.query)) throw new Error('Unexpected contract fixture request');
        return new Response(JSON.stringify(fixture.answer), { status: fixture.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch });
    void readBrowse(() => discoveryApi(main, 'en').resources(fixture.query)).then(read => { if (active) setResult(read); });
    return () => { active = false; };
  }, [kind, persona, loading]);
  return <Providers>
    {!result ? <p role="status" aria-busy="true">{browseMessages.en.loading}</p> : null}
    <DiscoverView state={fixture.state} locale="en" topics={[]} sections={null} results={result}
      signedIn={persona !== 'visitor'} />
  </Providers>;
}

const meta = { title: 'Discover/Realm closure search (contract fixtures)', component: RealmSearch,
  args: { kind: 'closed', persona: 'visitor' }, parameters: { route: { pathname: '/en/discover' },
    docs: { description: { component: 'Contract fixtures, not recorded answers. Exact requests and states are exported as missingRealmSearchStates for wave proof.' } } },
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    if (args.loading) await expect(await canvas.findByText(browseMessages.en.loading)).toHaveAttribute('aria-busy', 'true');
    else if (args.kind === 'global') {
      await expect(await canvas.findByRole('link', { name: 'Lantern original' })).toBeVisible();
      await expect(canvas.getByRole('link', { name: 'Original author' })).toBeVisible();
    } else if (args.kind === 'empty') await expect(await canvas.findByText(browseMessages.en.empty)).toBeVisible();
    else await expect(await canvas.findByRole('alert')).toHaveTextContent(browseMessages.en.unavailable);
  },
} satisfies Meta<typeof RealmSearch>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Visitor: Story = {};
export const Stranger: Story = { args: { persona: 'stranger' } };
export const Member: Story = { args: { persona: 'member' } };
export const Owner: Story = { args: { persona: 'owner' } };
export const Moderator: Story = { args: { persona: 'moderator' } };
export const Operator: Story = { args: { persona: 'operator' } };
export const ClosedContinuation: Story = { args: { kind: 'closed-continuation' } };
export const IndependentOriginal: Story = { args: { kind: 'global' } };
export const Empty: Story = { args: { kind: 'empty' } };
export const Unavailable503: Story = { args: { kind: 'error' } };
export const Loading: Story = { args: { loading: true } };
export const Phone: Story = { globals: { viewport: { value: 'phone' } } };
export const IndependentOriginalPhone: Story = { args: { kind: 'global' }, globals: { viewport: { value: 'phone' } } };
