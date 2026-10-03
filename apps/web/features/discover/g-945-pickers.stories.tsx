import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import type { EntityPickerSelection } from '@rezics/ui/entity-picker';
import type { UiLocale } from '../../i18n/define.ts';
import { Providers } from '../shell/providers.tsx';
import { ScopeBar } from '../work-page/scope-bar.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { RealmSubmit, type RealmPickerItem } from '../studio/realm-submit.tsx';
import { agents, ids, publishedTexts, storyMain } from '../studio/fixtures.ts';
import { messages as studioMessages } from '../studio/messages.ts';
import zhHant from '../studio/messages/zh-Hant.ts';
import zhHans from '../studio/messages/zh-Hans.ts';
import ja from '../studio/messages/ja.ts';
import ko from '../studio/messages/ko.ts';
import de from '../studio/messages/de.ts';
import fr from '../studio/messages/fr.ts';
import es from '../studio/messages/es.ts';
import { TopicPicker, type TopicItem } from './topic-picker.tsx';
import { browseId, fixtureTopicLoader, fixtureListLoader } from './browse-fixtures.ts';
import { PositionControl } from '../wiki/position-control.tsx';
import { copyOf } from '../wiki/messages.ts';
import { positionPickerPage } from '../wiki/position-picker.ts';
import { browseMessages } from './browse-messages.ts';

const translations = { en: {}, 'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es };
const communities: RealmPickerItem[] = Array.from({ length: 2400 }, (_, index) => ({
  value: browseId(6000 + index),
  label: `Community ${index + 1}`,
  realm: {
    id: browseId(6000 + index),
    name: { value: `Community ${index + 1}`, language: 'en', direction: direction('en', `Community ${index + 1}`), basis: 'requested' },
    reviewMode: 'mandatory',
  },
}));
const positions = Array.from({ length: 2400 }, (_, index) => ({
  occurrence: browseId(index + 1),
  work: browseId(9999),
  structure: browseId(9998),
  revision: browseId(9997),
  parent: browseId(9998),
  segmentKey: 'main',
  orderKey: String(index),
  role: 'chapter' as const,
  target: null,
  labels: [{ value: `Chapter ${index + 1}`, language: 'en' }],
  ordinal: index + 1,
}));
function Pickers({ locale, slow, fail }: { locale: UiLocale; slow?: boolean; fail?: boolean }) {
  const [value, setValue] = useState<EntityPickerSelection<TopicItem>[]>([]);
  const [loadTopics] = useState(() => fixtureTopicLoader({ slow, fail }));
  const [loadPopulations] = useState(() => fixtureListLoader(communities, { slow, fail }));
  const [loadRealms] = useState(() => fixtureListLoader(communities, { slow, fail }));
  const [loadPositions] = useState(() =>
    fixtureListLoader(
      positionPickerPage({ items: positions, nextCursor: null, complete: true }, '', locale, null)
        .items,
      { slow, fail },
    ),
  );
  const [main] = useState(() => storyMain().main);
  return (
    <Providers>
      <div className="grid min-w-0 gap-8 p-4">
        <TopicPicker
          locale={locale}
          value={value}
          onChange={setValue}
          allowExclude
          load={loadTopics}
        />
        <ScopeBar
          workRef="00000000-0000-4000-8000-000000000999"
          scope={{ kind: 'global' }}
          locale={locale}
          messages={workMessages[locale]}
          target={browseId(999)}
          realms={communities.slice(0, 20).map((item, index) => ({
            id: item.value.slice(-36),
            name: item.realm.name,
            ratingCount: 10000 - index,
            readerCommunity: index === 2,
          }))}
          load={loadPopulations}
        />
        <RealmSubmit
          agent={agents[0]!}
          work={{ id: ids.serial, mainVersion: browseId(999), book: true }}
          texts={{ ok: true, data: publishedTexts }}
          realms={{ ok: true, data: communities.slice(0, 20).map((item) => item.realm) }}
          open={[]}
          locale={locale}
          messages={{ ...studioMessages, ...translations[locale] }}
          main={main}
          loadRealms={loadRealms}
        />
        <PositionControl
          copy={copyOf(locale)}
          locale={locale}
          at={{ kind: 'all' }}
          options={Array.from({ length: 20 }, (_, index) => ({
            id: browseId(index + 1),
            label: { value: `Chapter ${index + 1}`, lang: 'en', dir: direction('en', `Chapter ${index + 1}`) },
            href: `?position=${browseId(index + 1).slice(-36)}`,
            current: false,
          }))}
          progress={{ href: '?position=mine', current: false, resolved: null }}
          everything={{ href: '?position=all', current: true }}
          more
          load={loadPositions}
        />
      </div>
    </Providers>
  );
}
const meta = {
  title: 'Discover/Searchable choosers',
  component: Pickers,
  args: { locale: 'en' },
  parameters: { route: { pathname: '/en/discover' } },
} satisfies Meta<typeof Pickers>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Thousands: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Topics' }));
    await expect(await screen.findByRole('option', { name: /宇宙/ })).toBeVisible();
    await userEvent.click(screen.getByRole('option', { name: /宇宙/ }));
    await expect(canvas.getByRole('button', { name: /Exclude 宇宙/ })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /Exclude 宇宙/ }));
    await expect(canvas.getByRole('button', { name: /Include 宇宙/ })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Other communities…' }));
    const picker = screen.getByRole('combobox', { name: 'Find a community' });
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await expect(await screen.findByRole('option', { name: 'Community 40' })).toBeVisible();
  },
};
export const SearchWikiPosition: Story = {
  async play({ canvasElement }) {
    const bar = within(within(canvasElement).getByRole('region', { name: 'Reading position' }));
    await userEvent.click(bar.getByRole('button', { name: 'Showing everything' }));
    const search = await screen.findByRole('combobox', { name: browseMessages.en.searchChapters });
    await userEvent.click(search);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await expect(await screen.findByRole('option', { name: 'Chapter 40' })).toBeVisible();
    await userEvent.clear(search);
    await userEvent.type(search, 'Chapter 2400');
    await expect(await screen.findByRole('option', { name: 'Chapter 2400' })).toBeVisible();
    await expect(screen.queryByRole('option', { name: 'Chapter 40' })).toBeNull();
    await expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  },
};
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' } };
export const French: Story = { args: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' } };
export const Phone: Story = {
  args: { locale: 'zh-Hans' },
  globals: { viewport: { value: 'phone' } },
};
export const Slow: Story = { args: { slow: true } };
export const Failed: Story = { args: { fail: true } };
