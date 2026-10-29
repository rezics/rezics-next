import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pageReady, pagePaths } from './page';
import libraryCollectionRecording from '../kernel/recorded/library-collection.json';
import { userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const id = libraryCollectionRecording.collection.id;
const tag = '00000000-0000-4000-8000-000000000123';
const base = pagePaths['library-collection'];
const meta = { title: 'Pages/Library/Collection Filters', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const story = (path: string): Story => ({
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={path} />,
});

export const NoFilter = story(base);
export const Harem: Story = {
  ...story(`${base}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=Harem`),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    if (window.innerWidth <= 600) {
      await userEvent.click(within(canvasElement).getByRole('button', { name: m.collection_filters() }));
      await within(document.body).findByRole('dialog');
    }
    await within(canvasElement).findByDisplayValue(getLocale() === 'zh-Hans' ? '后宫' : 'Harem');
  },
};
export const WordRange = story(`${base}?r.schema%3AwordCount=1000001%2C`);
export const Both = story(
  `${base}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=Harem&r.schema%3AwordCount=1000001%2C`,
);
export const NoMatch = story(
  `${base}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000999&l.schema%3Akeywords=Harem`,
);
export const Preparing = story(
  `${base}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000998&l.schema%3Akeywords=Preparing`,
);

export const NoFilterChinese = story(`/zh-Hans/collections/${id}`);
export const HaremChinese = story(`/zh-Hans/collections/${id}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=后宫`);
export const WordRangeChinese = story(`/zh-Hans/collections/${id}?r.schema%3AwordCount=1000001%2C`);
export const BothChinese = story(
  `/zh-Hans/collections/${id}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=后宫&r.schema%3AwordCount=1000001%2C`,
);
export const NoMatchChinese = story(
  `/zh-Hans/collections/${id}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000999&l.schema%3Akeywords=后宫`,
);
export const PreparingChinese = story(
  `/zh-Hans/collections/${id}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000998&l.schema%3Akeywords=准备中`,
);
