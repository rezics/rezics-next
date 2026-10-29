import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from './page';
import { pageReady } from './page';

const viewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
const meta = {
  title: 'Pages/Library/Collection dynamic',
  parameters: { layout: 'fullscreen', viewport: { viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const EverythingEnglishLightPhone390: Story = {
  name: 'Everything · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingEnglishLightDesktop1280: Story = {
  name: 'Everything · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingEnglishDarkPhone390: Story = {
  name: 'Everything · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingEnglishDarkDesktop1280: Story = {
  name: 'Everything · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseLightPhone390: Story = {
  name: 'Everything · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseLightDesktop1280: Story = {
  name: 'Everything · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseDarkPhone390: Story = {
  name: 'Everything · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseDarkDesktop1280: Story = {
  name: 'Everything · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const LikedEnglishLightPhone390: Story = {
  name: 'Liked · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedEnglishLightDesktop1280: Story = {
  name: 'Liked · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedEnglishDarkPhone390: Story = {
  name: 'Liked · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedEnglishDarkDesktop1280: Story = {
  name: 'Liked · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseLightPhone390: Story = {
  name: 'Liked · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseLightDesktop1280: Story = {
  name: 'Liked · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseDarkPhone390: Story = {
  name: 'Liked · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseDarkDesktop1280: Story = {
  name: 'Liked · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const StateEnglishLightPhone390: Story = {
  name: 'State · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateEnglishLightDesktop1280: Story = {
  name: 'State · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateEnglishDarkPhone390: Story = {
  name: 'State · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateEnglishDarkDesktop1280: Story = {
  name: 'State · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseLightPhone390: Story = {
  name: 'State · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseLightDesktop1280: Story = {
  name: 'State · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseDarkPhone390: Story = {
  name: 'State · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseDarkDesktop1280: Story = {
  name: 'State · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const EmptyEverythingEnglishLightPhone390: Story = {
  name: 'EmptyEverything · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingEnglishLightDesktop1280: Story = {
  name: 'EmptyEverything · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingEnglishDarkPhone390: Story = {
  name: 'EmptyEverything · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingEnglishDarkDesktop1280: Story = {
  name: 'EmptyEverything · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseLightPhone390: Story = {
  name: 'EmptyEverything · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseLightDesktop1280: Story = {
  name: 'EmptyEverything · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseDarkPhone390: Story = {
  name: 'EmptyEverything · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseDarkDesktop1280: Story = {
  name: 'EmptyEverything · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const RenamedEverythingEnglishLightPhone390: Story = {
  name: 'RenamedEverything · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingEnglishLightDesktop1280: Story = {
  name: 'RenamedEverything · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingEnglishDarkPhone390: Story = {
  name: 'RenamedEverything · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingEnglishDarkDesktop1280: Story = {
  name: 'RenamedEverything · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseLightPhone390: Story = {
  name: 'RenamedEverything · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseLightDesktop1280: Story = {
  name: 'RenamedEverything · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseDarkPhone390: Story = {
  name: 'RenamedEverything · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseDarkDesktop1280: Story = {
  name: 'RenamedEverything · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const StateOtherEnglishLightPhone390: Story = {
  name: 'StateOther · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherEnglishLightDesktop1280: Story = {
  name: 'StateOther · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherEnglishDarkPhone390: Story = {
  name: 'StateOther · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherEnglishDarkDesktop1280: Story = {
  name: 'StateOther · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseLightPhone390: Story = {
  name: 'StateOther · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseLightDesktop1280: Story = {
  name: 'StateOther · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseDarkPhone390: Story = {
  name: 'StateOther · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseDarkDesktop1280: Story = {
  name: 'StateOther · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const PagedEnglishLightPhone390: Story = {
  name: 'Paged · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedEnglishLightDesktop1280: Story = {
  name: 'Paged · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedEnglishDarkPhone390: Story = {
  name: 'Paged · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedEnglishDarkDesktop1280: Story = {
  name: 'Paged · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseLightPhone390: Story = {
  name: 'Paged · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseLightDesktop1280: Story = {
  name: 'Paged · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseDarkPhone390: Story = {
  name: 'Paged · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseDarkDesktop1280: Story = {
  name: 'Paged · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PreparingEnglishLightPhone390: Story = {
  name: 'Preparing · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingEnglishLightDesktop1280: Story = {
  name: 'Preparing · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingEnglishDarkPhone390: Story = {
  name: 'Preparing · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingEnglishDarkDesktop1280: Story = {
  name: 'Preparing · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseLightPhone390: Story = {
  name: 'Preparing · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseLightDesktop1280: Story = {
  name: 'Preparing · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseDarkPhone390: Story = {
  name: 'Preparing · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseDarkDesktop1280: Story = {
  name: 'Preparing · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const UnavailableEnglishLightPhone390: Story = {
  name: 'Unavailable · en · light · phone390',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableEnglishLightDesktop1280: Story = {
  name: 'Unavailable · en · light · desktop1280',
  globals: { locale: 'en', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableEnglishDarkPhone390: Story = {
  name: 'Unavailable · en · dark · phone390',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableEnglishDarkDesktop1280: Story = {
  name: 'Unavailable · en · dark · desktop1280',
  globals: { locale: 'en', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseLightPhone390: Story = {
  name: 'Unavailable · zh-Hans · light · phone390',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseLightDesktop1280: Story = {
  name: 'Unavailable · zh-Hans · light · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'light' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseDarkPhone390: Story = {
  name: 'Unavailable · zh-Hans · dark · phone390',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseDarkDesktop1280: Story = {
  name: 'Unavailable · zh-Hans · dark · desktop1280',
  globals: { locale: 'zh-Hans', theme: 'dark' },
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
