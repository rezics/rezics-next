import type { Meta, StoryObj } from '@storybook/react-vite';
import { withSurface } from '../stories/support.tsx';
import { MetaLine } from './meta-line.tsx';

const meta = {
  title: 'Components/Meta Line',
  component: MetaLine,
  args: { items: [] },
  decorators: [withSurface],
  parameters: { layout: 'centered' },
} satisfies Meta<typeof MetaLine>;
export default meta;
type Story = StoryObj<typeof meta>;

function Examples({ locale }: { locale: 'en' | 'zh-Hans' }) {
  const items =
    locale === 'en'
      ? ['Mira Okabe', '@mira', '5 days ago', 'Edited', 'Public post']
      : ['冈部未来', '@mira', '5 天前', '已编辑', '公开帖子'];
  return (
    <main lang={locale} className="w-[min(100vw-3rem,32rem)] space-y-6">
      <section className="space-y-2">
        <MetaLine items={items.slice(0, 2)} />
        <MetaLine items={items.slice(0, 3)} />
        <MetaLine items={items} />
      </section>
      <MetaLine
        className="block max-w-[240px] text-sm"
        items={[
          items[0],
          locale === 'en'
            ? 'A long descriptive item that wraps across several lines in a narrow metadata container'
            : '這是一段很長的描述內容，會在窄的中繼資料容器中換成數行顯示',
          items[2],
          items[3],
          items[4],
        ]}
      />
    </main>
  );
}

export const EnglishLight: Story = {
  globals: { locale: 'en', theme: 'light' },
  render: () => <Examples locale="en" />,
};
export const EnglishDark: Story = { ...EnglishLight, globals: { locale: 'en', theme: 'dark' } };
export const SimplifiedChineseLight: Story = {
  globals: { locale: 'zh-Hans', theme: 'light' },
  render: () => <Examples locale="zh-Hans" />,
};
export const SimplifiedChineseDark: Story = {
  ...SimplifiedChineseLight,
  globals: { locale: 'zh-Hans', theme: 'dark' },
};
