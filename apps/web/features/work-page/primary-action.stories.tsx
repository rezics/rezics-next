import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import type { EditionPreference } from '../tracking/types.ts';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';

// Contract-shaped state: the private choice retains its exact Release pin,
// while its language and currently readable edition title are unknown.
const preference: EditionPreference = {
  work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  language: null, version: 1,
  edition: { kind: 'release', resource: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003' },
};

function SavedReleaseStatus({ locale }: { locale: UiLocale }) {
  return <main className="max-w-sm p-6">
    <IdentityStatus preference={{ ok: true, data: preference }} progress={null}
      editionName={null} locale={locale} messages={messages[locale]} />
  </main>;
}

const meta = { title: 'Work page/Saved edition status', component: SavedReleaseStatus,
  args: { locale: 'en' }, globals: { viewport: { value: 'phone' } },
} satisfies Meta<typeof SavedReleaseStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnknownReleaseLanguage: Story = { async play({ canvasElement, args }) {
  const status = within(canvasElement).getByRole('list', { name: messages[args.locale].yourEdition });
  await expect(status).toHaveTextContent(messages[args.locale].unknownLanguage);
  await expect(status).not.toHaveTextContent('English');
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };

export const UnknownReleaseLanguageChinese: Story = { ...UnknownReleaseLanguage,
  args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
};
