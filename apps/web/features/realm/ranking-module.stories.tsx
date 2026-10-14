import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import { LibraryBigIcon } from 'lucide-react';
import { catalogs } from '../../i18n/catalogs.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { communityZone } from '../zones/fixtures.ts';
import type { ZoneMessages } from '../zones/messages.ts';
import { placedModule } from '../zones/presentation.ts';
import { ZoneHome, type ModuleState } from '../zones/zone-home.tsx';
import { loadRankingsModule } from './modules.ts';
import { rankingRealm, rankingStateSource } from './ranking-contract-states.ts';
import { rankingModule, rankingModuleContractCards, rankingModuleContractFetch, type RankingModuleState } from './ranking-module-contract-states.ts';
import { RankingSkeleton } from './ranking-page.tsx';
import { readRankingModuleAnswer } from './ranking-read.ts';
import { RealmPageStory } from './story-page.tsx';

function ModuleStory({ state, locale }: { state: RankingModuleState | 'loading'; locale: UiLocale }) {
  const [loaded, setLoaded] = useState<{ state: ModuleState<'ranking'>; messages: ZoneMessages;
    emptyTitle: string; emptyBody: string } | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    if (state === 'loading') return;
    const main = browserMainApi('https://contract.invalid', { fetcher: rankingModuleContractFetch(state), anonymous: true });
    void Promise.all([loadRankingsModule(rankingModule, { realm: rankingRealm, ref: 'ranking-garden', locale }, {
      cards: async () => rankingModuleContractCards(),
      rankings: (realm, _locale, interval, metric) => readRankingModuleAnswer(main, realm, interval, metric),
    }), catalogs.zones[locale](), catalogs.realm[locale]()]).then(([state, messages, realm]) => {
      if (active) setLoaded({ state, messages, emptyTitle: realm.emptyHomeTitle, emptyBody: realm.emptyHomeBody });
    });
    return () => { active = false; };
  }, [state, locale]);
  const zone = communityZone(locale);
  return <RealmPageStory zone={zone} locale={locale}>
    {loaded ? <ZoneHome modules={[{ module: { ...placedModule(rankingModule, null), type: 'ranking' }, state: loaded.state }]}
      zone={zone} pkg={null} locale={locale} messages={loaded.messages} slotAccess={null}
      empty={<EmptyState icon={LibraryBigIcon} title={loaded.emptyTitle} description={loaded.emptyBody} />} /> : <RankingSkeleton />}
  </RealmPageStory>;
}

const meta = {
  title: 'Realm/Ranking module contract states', component: ModuleStory,
  args: { state: 'populated', locale: 'en' }, globals: { viewport: { value: 'desktop' } },
  parameters: { docs: { description: { component: rankingStateSource + '. Chart interval requests and independent author credit are constructed in ranking-module-contract-states.ts.' } } },
  render: (args, { globals }) => <ModuleStory {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof ModuleStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedDesktop: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { name: 'Ranking garden' })).resolves.toBeVisible();
    await expect(canvas.getByText('Original ranking garden')).toBeVisible();
    await expect(canvas.getByText('Ranking garden author')).toBeVisible();
    await expect(canvas.getAllByRole('tab')).toHaveLength(3);
  },
};
export const PopulatedPhone: Story = { ...PopulatedDesktop, globals: { viewport: { value: 'phone' } } };
export const EmptyDesktop: Story = { args: { state: 'empty' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { name: 'Nothing here yet' })).resolves.toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Ranking garden' })).toBeNull();
  } };
export const EmptyPhone: Story = { ...EmptyDesktop, globals: { viewport: { value: 'phone' } } };
export const ErrorDesktop: Story = { args: { state: 'error' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('status')).resolves.toBeVisible(); } };
export const ErrorPhone: Story = { ...ErrorDesktop, globals: { viewport: { value: 'phone' } } };
export const IncompleteWindow: Story = { ...ErrorDesktop, args: { state: 'underfilled' } };
export const LoadingDesktop: Story = { args: { state: 'loading' },
  async play({ canvasElement }) { await expect(canvasElement.querySelector('[aria-busy="true"]')).not.toBeNull(); } };
export const LoadingPhone: Story = { ...LoadingDesktop, globals: { viewport: { value: 'phone' } } };
