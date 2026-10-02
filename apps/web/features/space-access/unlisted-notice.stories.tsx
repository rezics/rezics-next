import type { Meta, StoryObj } from '@storybook/react-vite';
import { captureAccessStory, joinPageFixture } from '../manage/settings-fixtures.ts';
import { UnlistedSpaceNotice } from './unlisted-notice.tsx';

const meta = { title: 'Space access/Unlisted', component: UnlistedSpaceNotice,
  args: { locale: 'en', discovery: joinPageFixture.discovery },
  decorators: [Story => <div className="mx-auto max-w-3xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof UnlistedSpaceNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { async play() { await captureAccessStory('unlisted'); } };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
