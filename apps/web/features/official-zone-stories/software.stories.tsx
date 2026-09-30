import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneContext, ZoneWork } from '@rezics/zone-sdk';
import { expect, within } from 'storybook/test';
import { RealmPageStory } from '../realm/story-page.tsx';
import { presetTokens } from '../zones/presentation.ts';
import type { PlacedModule } from '../zones/zone-home.tsx';
import software from '../../zones/official/software/index.tsx';

const text = (value: string) => ({ value, lang: 'en', dir: 'ltr' as const });
const titles = ['Firefox', 'GIMP', 'Blender', 'Krita'];
const works: ZoneWork[] = titles.map((title, index) => {
  const id = `00000000-0000-7000-8001-${String(index + 1).padStart(12, '0')}`;
  return { id: `https://rezics.com/id/${id}`, href: `/w/${id}`, title: text(title), cover: null,
    kind: 'package', author: null, tagline: text(['Browse the web.', 'Edit raster images.',
      'Create 3D scenes.', 'Paint and illustrate.'][index]!), status: null, chapters: null, words: null,
    updatedAt: null, decision: `/r/software/decisions#decision-${index}` };
});

function Page({ locale = 'en' }: { locale?: 'en' | 'zh-Hans' }) {
  const zh = locale === 'zh-Hans';
  const home = `/${locale}/r/software`;
  const zone: ZoneContext = { slug: 'software', realm: 'https://rezics.com/id/00000000-0000-7000-8001-000000000099',
    name: { value: zh ? '软件' : 'Software', lang: locale, dir: 'ltr' },
    description: { value: zh ? '开源应用与获取途径。' : 'Open-source apps and where to get them.',
      lang: locale, dir: 'ltr' }, icon: null, hero: null, tokens: presetTokens.clean, locale,
    links: { home, browse: `${home}/browse`, works: `${home}/browse`, discussions: `${home}/discussions`,
      decisions: `${home}/decisions`, about: `${home}/about` } };
  const modules = [
    { module: { id: 'picks', type: 'hero-carousel', title: zh ? '精选应用' : 'Featured apps',
      rail: false, layout: 'covers', shuffle: false, more: null }, state: { state: 'ready', data: {
      banners: works.map(work => ({ id: work.id, title: work.title!, href: work.href, image: null, work })) } } },
    { module: { id: 'creative', type: 'shelf', title: zh ? '开始创作' : 'Create something',
      rail: false, layout: 'covers', shuffle: false, more: `${home}/browse` }, state: { state: 'ready', data: {
      tabs: [{ id: 'creative', label: zh ? '开始创作' : 'Create something', items: works }] } } },
  ] as PlacedModule[];
  return <RealmPageStory zone={zone} modules={modules} locale={locale} pkg={software}
    execution={{ mode: 'package', slug: 'software' }} />;
}

const meta = { title: 'Zones/Official software', component: Page } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('heading', { name: 'Featured apps', level: 2 })).toBeVisible();
  await expect(canvas.getAllByText('Browse the web.')[0]).toBeVisible();
  await expect(canvas.queryByText(/Version not tracked/)).toBeNull();
  await expect(canvas.queryByRole('link', { name: 'Project website' })).toBeNull();
  await expect(canvas.getAllByRole('link', { name: 'Why Firefox is here' })[0]).toBeVisible();
} };
export const Chinese: Story = { args: { locale: 'zh-Hans' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('heading', { name: '精选应用', level: 2 })).toBeVisible();
  await expect(within(canvasElement).queryByText(/暂无版本记录/)).toBeNull();
} };
