import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';
import { ZonePageMissing } from './page-missing.tsx';

const locales = { en: messages, 'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es };

const meta = {
  title: 'Zones/Missing page',
  component: ZonePageMissing,
  args: {
    title: messages.pageMissingTitle,
    body: messages.pageMissingBody,
    back: messages.pageMissingBack,
    href: spaceHref('franchise-wiki', 'site'),
  },
  parameters: { route: { pathname: localizedPath(spaceHref('franchise-wiki', 'site', ['missing']), 'en') } },
  render: (_args, { globals }) => {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    const copy = { ...messages, ...locales[locale] };
    return (
      <ZonePageMissing
        title={copy.pageMissingTitle}
        body={copy.pageMissingBody}
        back={copy.pageMissingBack}
        href={spaceHref('franchise-wiki', 'site')}
      />
    );
  },
} satisfies Meta<typeof ZonePageMissing>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The community is still here; only this address has no page. */
export const Missing: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'This page isn’t here' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('The address may be wrong, or the page may have moved.'),
    ).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'This community isn’t here' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Back to this community' })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('franchise-wiki', 'site'), 'en'),
    );
  },
};

export const MissingJapanese: Story = {
  globals: { locale: 'ja' },
  parameters: { route: { pathname: localizedPath(spaceHref('franchise-wiki', 'site', ['missing']), 'ja') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'このページは見つかりません' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('heading', { name: 'このコミュニティは見つかりません' }),
    ).toBeNull();
  },
};

export const MissingPhone: Story = { globals: { viewport: { value: 'phone' } } };
