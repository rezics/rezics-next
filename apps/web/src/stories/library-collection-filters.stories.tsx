import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pageReady, pagePaths } from './page';
import libraryCollectionRecording from '../kernel/recorded/library-collection.json';
import { userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const id = libraryCollectionRecording.collection.id;
const tag = '00000000-0000-4000-8000-000000000123';
const base = pagePaths['library-collection'];
const viewports = {
  phone390: { name: '390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const },
  desktop1280: { name: '1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' as const },
};
const meta = {
  title: 'Pages/Library/Collection Filters',
  parameters: { layout: 'fullscreen', viewport: { viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function story(path: string, viewport: keyof typeof viewports, openFilters = false): Story {
  return {
    name: `${path.includes('/zh-Hans/') ? 'Chinese' : 'English'} · ${path.includes('f.schema') ? 'Harem' : path.includes('r.schema') ? 'Word range' : 'No filter'} · ${viewports[viewport].name}`,
    parameters: { viewport: { defaultViewport: viewport } },
    play: async ({ canvasElement }) => {
      await pageReady({ canvasElement });
      if (openFilters && window.innerWidth <= 600) {
        await userEvent.click(within(canvasElement).getByRole('button', { name: m.collection_filters() }));
        await within(document.body).findByRole('dialog');
      }
      if (openFilters) await within(canvasElement).findByDisplayValue(getLocale() === 'zh-Hans' ? '后宫' : 'Harem');
    },
    render: () => <PageStory visitor="Signed Out" path={path} />,
  };
}

const en = {
  noFilter: base,
  harem: `${base}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=Harem`,
  range: `${base}?r.schema%3AwordCount=1000001%2C`,
  both: `${base}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=Harem&r.schema%3AwordCount=1000001%2C`,
  noMatch: `${base}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000999&l.schema%3Akeywords=Harem`,
  preparing: `${base}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000998&l.schema%3Akeywords=Preparing`,
};
const zh = {
  noFilter: `/zh-Hans/collections/${id}`,
  harem: `/zh-Hans/collections/${id}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=后宫`,
  range: `/zh-Hans/collections/${id}?r.schema%3AwordCount=1000001%2C`,
  both: `/zh-Hans/collections/${id}?f.schema%3Akeywords=${tag}&l.schema%3Akeywords=后宫&r.schema%3AwordCount=1000001%2C`,
  noMatch: `/zh-Hans/collections/${id}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000999&l.schema%3Akeywords=后宫`,
  preparing: `/zh-Hans/collections/${id}?f.schema%3Akeywords=00000000-0000-4000-8000-000000000998&l.schema%3Akeywords=准备中`,
};

export const NoFilterEnglishPhone = story(en.noFilter, 'phone390');
export const NoFilterEnglishDesktop = story(en.noFilter, 'desktop1280');
export const HaremEnglishPhone = story(en.harem, 'phone390', true);
export const HaremEnglishDesktop = story(en.harem, 'desktop1280', true);
export const RangeEnglishPhone = story(en.range, 'phone390');
export const RangeEnglishDesktop = story(en.range, 'desktop1280');
export const BothEnglishPhone = story(en.both, 'phone390');
export const BothEnglishDesktop = story(en.both, 'desktop1280');
export const NoMatchEnglishPhone = story(en.noMatch, 'phone390');
export const NoMatchEnglishDesktop = story(en.noMatch, 'desktop1280');
export const PreparingEnglishPhone = story(en.preparing, 'phone390');
export const PreparingEnglishDesktop = story(en.preparing, 'desktop1280');

export const NoFilterChinesePhone = story(zh.noFilter, 'phone390');
export const NoFilterChineseDesktop = story(zh.noFilter, 'desktop1280');
export const HaremChinesePhone = story(zh.harem, 'phone390', true);
export const HaremChineseDesktop = story(zh.harem, 'desktop1280', true);
export const RangeChinesePhone = story(zh.range, 'phone390');
export const RangeChineseDesktop = story(zh.range, 'desktop1280');
export const BothChinesePhone = story(zh.both, 'phone390');
export const BothChineseDesktop = story(zh.both, 'desktop1280');
export const NoMatchChinesePhone = story(zh.noMatch, 'phone390');
export const NoMatchChineseDesktop = story(zh.noMatch, 'desktop1280');
export const PreparingChinesePhone = story(zh.preparing, 'phone390');
export const PreparingChineseDesktop = story(zh.preparing, 'desktop1280');
