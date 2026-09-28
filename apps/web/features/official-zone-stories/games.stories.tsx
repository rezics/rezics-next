import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneContext, ZoneWork } from '@rezics/zone-sdk';
import { expect, within } from 'storybook/test';
import { RealmPageStory } from '../realm/story-page.tsx';
import { presetTokens } from '../zones/presentation.ts';
import type { PlacedModule } from '../zones/zone-home.tsx';
import games from '../../zones/official/games/index.tsx';

const text = (value: string) => ({ value, lang: 'en', dir: 'ltr' as const });
const titles = ['Stardew Valley', 'Hades II', 'Witchbrook', 'Outer Wilds'];
const works: ZoneWork[] = titles.map((title, index) => {
  const id = `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
  return { id: `https://rezics.com/id/${id}`, href: `/w/${id}`, title: text(title), cover: null,
    kind: 'document', author: null, tagline: text([
      'Build a farm and settle into a small town.', 'Take on the Titan of Time as Melinoë.',
      'Study magic in a seaside town.', 'Investigate a solar system caught in a time loop.'][index]!),
    status: null, chapters: null, words: null, updatedAt: null,
    decision: `/r/games/decisions#decision-${index}`,
    game: { status: index === 2 ? 'upcoming' : 'released', releaseDate: null,
      platforms: ['Windows'], languages: ['English'], tags: index === 0 ? ['Farming', 'Life sim'] : ['Exploration'],
      screenshots: [], review: index === 0 ? { label: 'Very positive', count: 128, period: 'overall' } : null,
      modsZone: index === 0 } };
});

function Page({ locale = 'en' }: { locale?: 'en' | 'zh-Hans' }) {
  const zh = locale === 'zh-Hans';
  const home = `/${locale}/r/games`;
  const zone: ZoneContext = { slug: 'games', realm: 'https://rezics.com/id/00000000-0000-7000-8000-000000000099',
    name: { value: zh ? '游戏' : 'Games', lang: locale, dir: 'ltr' },
    description: { value: zh ? '发现游戏与编辑推荐。' : 'Discover games and the reasons editors picked them.',
      lang: locale, dir: 'ltr' }, icon: null, hero: null, tokens: presetTokens.vibrant, locale,
    links: { home, browse: `${home}/browse`, works: `${home}/browse`, discussions: `${home}/discussions`,
      decisions: `${home}/decisions`, about: `${home}/about` } };
  const modules = [
    { module: { id: 'picks', type: 'hero-carousel', title: zh ? '精选游戏' : 'Featured games',
      rail: false, layout: 'covers', shuffle: false, more: null }, state: { state: 'ready', data: {
      banners: works.map(work => ({ id: work.id, title: work.title!, href: work.href, image: null, work })) } } },
    { module: { id: 'recent', type: 'shelf', title: zh ? '新近推荐' : 'Newly picked',
      rail: false, layout: 'covers', shuffle: false, more: `${home}/browse` }, state: { state: 'ready', data: {
      tabs: [{ id: 'recent', label: zh ? '新近推荐' : 'Newly picked', items: works }] } } },
  ] as PlacedModule[];
  return <RealmPageStory zone={zone} modules={modules} locale={locale} pkg={games}
    execution={{ mode: 'package', slug: 'games' }} />;
}

const meta = { title: 'Zones/Official games', component: Page } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('heading', { name: 'Featured games', level: 2 })).toBeVisible();
  await expect(canvas.getAllByText(/Very positive · 128 reviews/)[0]).toBeVisible();
  await expect(canvas.getAllByRole('link', { name: 'Browse mods' })[0]).toBeVisible();
  await expect(canvas.getAllByRole('link', { name: 'Why Stardew Valley is here' })[0]).toBeVisible();
} };
export const Chinese: Story = { args: { locale: 'zh-Hans' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('heading', { name: '精选游戏', level: 2 })).toBeVisible();
  await expect(within(canvasElement).getAllByRole('link', { name: '浏览模组' })[0]).toBeVisible();
} };
