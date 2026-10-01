import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import type { Loaded, RelationsPage } from '../work-levels/types.ts';
import { character, characterRelations, wikiRealm } from './hub-fixtures.ts';
import { messages } from './messages.ts';
import { WikiSectionView } from './wiki.tsx';

interface WikiArgs { locale: UiLocale; zone: string | null; characters: Loaded<RelationsPage> | null }

function Wiki({ locale, zone, characters }: WikiArgs) {
  return <PageContainer className="max-w-3xl">
    <WikiSectionView wiki={{ zone: { ok: true, data: zone }, characters }} locale={locale} messages={messages[locale]} />
  </PageContainer>;
}

const kirito = character('Kirito', 'c1');
const asuna = character('Asuna', 'c2');

const wiki = {
  title: 'Work page/Hub/Explore the wiki',
  component: Wiki,
  args: { locale: 'en', zone: wikiRealm, characters: characterRelations([kirito, asuna]) },
} satisfies Meta<WikiArgs>;
export default wiki;
type WikiStory = StoryObj<typeof wiki>;

/** The Work names its wiki Zone: the first characters Main revealed, and the Zone's own routes. */
export const WikiPresent: WikiStory = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const section = canvas.getByRole('region', { name: 'Explore the wiki' });
    const list = within(section).getByRole('list', { name: 'Main characters' });
    await expect(within(list).getByRole('link', { name: 'Kirito' })).toHaveAttribute('href',
      expect.stringMatching(/^\/en\/e\/[0-9a-f-]{36}$/));
    await expect(within(section).getByRole('link', { name: 'All characters' })).toHaveAttribute('href',
      `/en/r/${wikiRealm}/characters`);
    await expect(within(section).getByRole('link', { name: 'Chapter guide' })).toHaveAttribute('href',
      `/en/r/${wikiRealm}/chapters`);
    await expect(within(section).getByRole('link', { name: 'Timeline' })).toHaveAttribute('href',
      `/en/r/${wikiRealm}/events`);
    await expect(within(section).getByText('Shown up to your reading position, so nothing is given away.')).toBeVisible();
  },
};

/** No statement names a wiki: one line says so and how holders build one. */
export const WikiAbsent: WikiStory = {
  args: { zone: null, characters: null },
  async play({ canvasElement }) {
    const section = within(canvasElement).getByRole('region', { name: 'Explore the wiki' });
    await expect(section).toHaveTextContent('No wiki exists for this Work yet.');
    await expect(within(section).queryByRole('list')).toBeNull();
  },
};

/** The wiki exists but the reader has not reached anything it reveals: no name leaks, the reason is said. */
export const WikiWithheldByPosition: WikiStory = {
  args: { characters: characterRelations([]) },
  async play({ canvasElement }) {
    const section = within(canvasElement).getByRole('region', { name: 'Explore the wiki' });
    await expect(section).toHaveTextContent('Nothing is revealed yet at your place in the story.');
    await expect(within(section).queryByText('Kirito')).toBeNull();
    // The wiki itself is still one tap away.
    await expect(within(section).getByRole('link', { name: 'Open the wiki' })).toHaveAttribute('href', `/en/r/${wikiRealm}`);
  },
};

export const WikiFailed: WikiStory = {
  render: ({ locale }) => <PageContainer className="max-w-3xl">
    <WikiSectionView wiki={{ zone: { ok: false, failure: 'unavailable' }, characters: null }} locale={locale}
      messages={messages[locale]} /></PageContainer>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('The wiki could not be loaded.');
  },
};

export const WikiChinese: WikiStory = {
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const section = within(canvasElement).getByRole('region', { name: '探索百科' });
    await expect(within(section).getByRole('link', { name: '章節導覽' })).toBeVisible();
    await expect(within(section).getByText('只顯示到你的閱讀進度為止，不會劇透。')).toBeVisible();
  },
};
