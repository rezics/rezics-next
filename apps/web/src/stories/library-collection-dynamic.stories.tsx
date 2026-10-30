import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from './page';
import { pageReady } from './page';

const meta = {
  title: 'Pages/Library/Collection',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const EverythingEnglishLightPhone390: Story = {
  name: 'Signed out, Everything collection',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingEnglishLightDesktop1280: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingEnglishDarkPhone390: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingEnglishDarkDesktop1280: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseLightPhone390: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseLightDesktop1280: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseDarkPhone390: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const EverythingChineseDarkDesktop1280: Story = {
  name: 'Signed out, Everything collection',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};
export const LikedEnglishLightPhone390: Story = {
  name: 'Signed out, Liked collection',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedEnglishLightDesktop1280: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedEnglishDarkPhone390: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedEnglishDarkDesktop1280: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseLightPhone390: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseLightDesktop1280: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseDarkPhone390: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const LikedChineseDarkDesktop1280: Story = {
  name: 'Signed out, Liked collection',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};
export const StateEnglishLightPhone390: Story = {
  name: 'Signed out, state selected',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateEnglishLightDesktop1280: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateEnglishDarkPhone390: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateEnglishDarkDesktop1280: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseLightPhone390: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseLightDesktop1280: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseDarkPhone390: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const StateChineseDarkDesktop1280: Story = {
  name: 'Signed out, state selected',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};
export const EmptyEverythingEnglishLightPhone390: Story = {
  name: 'Signed out, Everything empty',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingEnglishLightDesktop1280: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingEnglishDarkPhone390: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingEnglishDarkDesktop1280: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseLightPhone390: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseLightDesktop1280: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseDarkPhone390: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const EmptyEverythingChineseDarkDesktop1280: Story = {
  name: 'Signed out, Everything empty',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};
export const RenamedEverythingEnglishLightPhone390: Story = {
  name: 'Signed out, renamed collection',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingEnglishLightDesktop1280: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingEnglishDarkPhone390: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingEnglishDarkDesktop1280: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseLightPhone390: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseLightDesktop1280: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseDarkPhone390: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const RenamedEverythingChineseDarkDesktop1280: Story = {
  name: 'Signed out, renamed collection',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};
export const StateOtherEnglishLightPhone390: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherEnglishLightDesktop1280: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherEnglishDarkPhone390: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherEnglishDarkDesktop1280: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseLightPhone390: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseLightDesktop1280: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseDarkPhone390: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const StateOtherChineseDarkDesktop1280: Story = {
  name: 'Signed out, alternate state selected',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};
export const PagedEnglishLightPhone390: Story = {
  name: 'Signed out, later collection page',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedEnglishLightDesktop1280: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedEnglishDarkPhone390: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedEnglishDarkDesktop1280: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseLightPhone390: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseLightDesktop1280: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseDarkPhone390: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PagedChineseDarkDesktop1280: Story = {
  name: 'Signed out, later collection page',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};
export const PreparingEnglishLightPhone390: Story = {
  name: 'Signed out, preparing',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingEnglishLightDesktop1280: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingEnglishDarkPhone390: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingEnglishDarkDesktop1280: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseLightPhone390: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseLightDesktop1280: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseDarkPhone390: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const PreparingChineseDarkDesktop1280: Story = {
  name: 'Signed out, preparing',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};
export const UnavailableEnglishLightPhone390: Story = {
  name: 'Signed out, unavailable',
  globals: { viewport: { value: 'phone' } },
  tags: ['!dev'],
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableEnglishLightDesktop1280: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableEnglishDarkPhone390: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableEnglishDarkDesktop1280: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { locale: 'en', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseLightPhone390: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseLightDesktop1280: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'light' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseDarkPhone390: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
export const UnavailableChineseDarkDesktop1280: Story = {
  name: 'Signed out, unavailable',
  tags: ['!dev'],
  globals: { locale: 'zh-Hans', theme: 'dark' },
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
