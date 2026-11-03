import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { HomeFeed } from '../features/pages/home-feed';
import type { HomeFeedResult } from '../features/pages/home-feed-read';
import { homeFeedStoryPage } from '../kernel/fake/home-feed-stories';
import { homeFeedRecoveryMessages } from '../features/feed/feed-empty-state';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const scenarios = ['discovery', 'following', 'filtered', 'continuation', 'sparse', 'partial', 'partial-rows',
  'preparing', 'loading', 'auth', 'closed', 'denied', 'cursor', 'deadline', 'request', 'unavailable'] as const;
type Scenario = typeof scenarios[number];

function Recovery({ initial = 'discovery', long = false }: { initial?: Scenario; long?: boolean }) {
  const locale = getLocale();
  const [client] = useState(() => new QueryClient());
  const [scenario, setScenario] = useState<Scenario>(initial);
  const [actions, setActions] = useState(0);
  const [kind, setKind] = useState(true);
  const [other, setOther] = useState(true);
  const [pending, setPending] = useState(false);
  const filtered = scenario === 'filtered' && (kind || other);
  const base = homeFeedStoryPage(locale, true, scenario === 'partial-rows' ? 'partial' : 'empty');
  let result: HomeFeedResult;
  if (['loading', 'auth', 'closed', 'denied', 'cursor', 'deadline', 'request', 'unavailable'].includes(scenario)) {
    result = { state: scenario as 'loading' | 'auth' | 'closed' | 'denied' | 'cursor' | 'deadline' | 'request' | 'unavailable', code: 'prepared-recovery-state' };
  } else {
    result = { state: 'ready', page: {
      ...base,
      feedItems: scenario === 'partial-rows' ? base.feedItems : [],
      next: scenario === 'sparse' ? 'prepared-next-page' : null,
      sources: scenario === 'partial' || scenario === 'preparing'
        ? { ...base.sources, discovery: scenario === 'preparing' ? 'preparing' : 'unavailable' }
        : base.sources,
    } };
  }
  const recover = () => { setActions((value) => value + 1); setScenario('discovery'); };
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
        <aside aria-label="Prepared recovery scenarios" className="space-y-3 rounded-lg border border-border p-3">
          <p>Prepared feed recovery scenarios. No native requests or native acceptance evidence.</p>
          <label className="grid gap-1 text-sm">Prepared state
            <select className="min-h-11 max-w-full rounded border bg-background px-2" value={scenario}
              onChange={(event) => { setScenario(event.currentTarget.value as Scenario); setPending(false); setKind(true); setOther(true); }}>
              {scenarios.map((state) => <option key={state}>{state}</option>)}
            </select>
          </label>
          <button className="min-h-11 rounded border px-3" onClick={() => setPending(!pending)}>Prepared background refresh</button>
          <output aria-label="Prepared explicit actions">{actions}</output>
        </aside>
        {long ? <p className="break-words text-sm">{m.home_empty_partial_body().repeat(4)}</p> : null}
        <HomeFeed result={result} locale={locale} signedIn busy={pending}
          stream={scenario === 'following' ? 'following' : 'home'}
          input={{ stream: scenario === 'following' ? 'following' : 'home',
            ...(scenario === 'continuation' ? { cursor: 'prepared-next-page' } : {}),
            ...(filtered && kind ? { kind: 'prepared-kind' } : {}),
            ...(filtered && other ? { spaceId: 'prepared-space' } : {}) }}
          activeFilters={filtered ? [
            ...(kind ? [<span key="kind">{long ? m.home_empty_filtered_body().repeat(3) : 'Prepared kind'}
              <button className="min-h-11 min-w-11" onClick={() => setKind(false)} aria-label="Remove prepared kind">×</button></span>] : []),
            ...(other ? [<span key="space">Prepared Space
              <button className="min-h-11 min-w-11" onClick={() => setOther(false)} aria-label="Remove prepared Space">×</button></span>] : []),
          ] : []}
          kindControl={<button className="min-h-11 rounded border px-3" onClick={() => setKind(false)}>Prepared kind control</button>}
          spaceControl={<button className="min-h-11 rounded border px-3" onClick={() => setOther(false)}>Prepared Space control</button>}
          onSelect={(stream) => { setActions((value) => value + 1); setScenario(stream === 'following' ? 'following' : 'discovery'); }}
          onRetry={recover} onRestart={recover}
          onNext={() => { setActions((value) => value + 1); setScenario('continuation'); }} />
      </div>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Patterns/Feed/Empty recovery', component: Recovery,
  parameters: { layout: 'fullscreen', viewport: { options: {
    phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
    desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
  } } },
} satisfies Meta<typeof Recovery>;
export default meta;
type Story = StoryObj<typeof meta>;

const journey: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const selector = canvas.getByRole('combobox', { name: 'Prepared state' });
  const select = async (state: Scenario) => { await userEvent.selectOptions(selector, state); };
  const frame = () => canvasElement.querySelector('[data-slot=empty-state]') as HTMLElement;
  const live = () => frame().querySelector('[role=status], [role=alert]')!;
  const emptyTitle = (context: 'discovery' | 'following' | 'filtered' | 'continuation') =>
    homeFeedRecoveryMessages(getLocale(), context).explanations!.empty!.title as string;
  await expect(canvas.getByRole('heading', { name: emptyTitle('discovery') })).toBeVisible();
  await select('following');
  await userEvent.click(within(frame()).getByRole('button', { name: m.home_feed_discovery() }));
  await expect(canvas.getByRole('heading', { name: emptyTitle('discovery') })).toBeVisible();
  await select('filtered');
  const filters = within(frame()).getByRole('button', { name: m.search_filters() });
  filters.focus();
  await userEvent.keyboard('{Enter}');
  await expect(canvas.getByRole('button', { name: 'Prepared kind control' })).toHaveFocus();
  await userEvent.click(canvas.getByRole('button', { name: 'Remove prepared kind' }));
  await expect(canvas.getByRole('button', { name: 'Remove prepared Space' })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: emptyTitle('filtered') })).toBeVisible();
  await select('sparse');
  await expect(live()).toHaveTextContent(m.home_feed_sparse());
  const next = within(frame()).getByRole('button', { name: m.library_next_page() });
  next.focus();
  await userEvent.keyboard('{Enter}');
  await expect(canvas.getByRole('region', { name: m.nav_home() })).toHaveFocus();
  await expect(canvas.getByRole('heading', { name: emptyTitle('continuation') })).toBeVisible();
  await userEvent.click(within(frame()).getByRole('button', { name: m.home_feed_restart() }));
  await select('partial');
  await expect(live()).toHaveTextContent(m.home_empty_partial_body());
  await expect(within(frame()).getByRole('link', { name: m.search_heading() })).toHaveAttribute('href', `/${getLocale()}/search`);
  await userEvent.click(within(frame()).getByRole('button', { name: m.library_follow_retry() }));
  await select('partial-rows');
  await expect(canvas.getAllByRole('listitem').length).toBeGreaterThan(0);
  await expect(canvasElement.querySelector('[data-slot=empty-state]')).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: 'Prepared background refresh' }));
  await expect(canvas.getAllByRole('listitem').length).toBeGreaterThan(0);
  await expect(canvas.getAllByRole('status')).toHaveLength(2); // Source explanation and prepared action output.
  for (const state of ['preparing', 'loading', 'auth', 'closed', 'denied', 'cursor', 'deadline', 'request', 'unavailable'] as const) {
    await select(state);
    await expect(frame()).toBeVisible();
    await expect(live()).not.toHaveTextContent(m.home_feed_empty());
    if (state === 'auth') await expect(within(frame()).getByRole('link', { name: m.account_sign_in() })).toHaveAttribute('href', expect.stringContaining(`/${getLocale()}/auth/sign-in`));
    if (state === 'closed' || state === 'denied' || state === 'loading') await expect(within(frame()).queryByRole('button')).toBeNull();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
    for (const control of frame().querySelectorAll('a, button')) await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
};
export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: journey };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: journey };
export const DesktopLight: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' }, play: journey };
export const DesktopDark: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'dark' }, play: journey };
export const LongKeyboardPhone: Story = { args: { long: true }, globals: { viewport: { value: 'phone390' }, theme: 'dark', locale: 'de' }, play: journey };
export const LongKeyboardDesktop: Story = { args: { long: true }, globals: { viewport: { value: 'desktop1280' }, theme: 'light', locale: 'de' }, play: journey };
