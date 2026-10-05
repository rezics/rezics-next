import { profileHref } from '../profile/route.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AccountMenu } from './account-menu.tsx';
import { messages } from './messages.ts';
import type { Session } from './session.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellZhHans from '../shell/messages/zh-Hans.ts';
import shellZhHant from '../shell/messages/zh-Hant.ts';
import shellJa from '../shell/messages/ja.ts';
import shellKo from '../shell/messages/ko.ts';
import shellDe from '../shell/messages/de.ts';
import shellFr from '../shell/messages/fr.ts';
import shellEs from '../shell/messages/es.ts';
import { isUiLocale, localeNames } from '../../i18n/define.ts';
import { accountRowName, contentPreferenceValue } from './account-menu-items.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { chooseMenuItem } from '../stories/choose-option.ts';

const ada = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
const pen = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
const agents: Session['agents'] = [
  { iri: ada, label: 'Aster', handle: 'aster', kind: 'pen-name', path: 'direct-principal' },
  { iri: pen, label: null, handle: null, kind: null, path: 'represented-agent' },
];
const session: Session = {
  user: { id: 'u1' },
  agent: { status: 'selected', agent: agents[0]! },
  agents,
  expiresAt: '2026-10-27T00:00:00.000Z',
};

const shellTranslations = {
  en: shellMessages,
  'zh-Hant': shellZhHant,
  'zh-Hans': shellZhHans,
  ja: shellJa,
  ko: shellKo,
  de: shellDe,
  fr: shellFr,
  es: shellEs,
};
const contentPreferences = {
  contentLanguages: ['en', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'ar'],
  spoilerPolicy: 'hide-unread' as const,
};

const meta = {
  title: 'Auth/Account menu',
  component: AccountMenu,
  args: { session, messages: messages.en, accountOrigin: 'https://account.rezics.test' },
  beforeEach({ parameters }) {
    const original = window.fetch;
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v1/me/person-preferences'))
        return Promise.resolve(
          Response.json(
            parameters.contentUnavailable
              ? { error: 'unavailable' }
              : {
                  ...contentPreferences,
                  profile: 'person-preferences-v1',
                  version: 0,
                  profileVisibility: 'public',
                  followPolicy: 'everyone',
                  hideReadingActivity: false,
                  blockedPeople: [],
                },
            { status: parameters.contentUnavailable ? 503 : 200 },
          ),
        );
      return original.call(window, input, init);
    }, original);
    return () => {
      window.fetch = original;
    };
  },
  decorators: [
    (Story, context) => {
      const locale = isUiLocale(context.globals.locale) ? context.globals.locale : 'en';
      return (
        <ShellProvider
          locale={locale}
          messages={{ ...shellMessages, ...shellTranslations[locale] }}
          initialTheme={context.parameters.theme ?? 'system'}
          initialCollapsed={false}
        >
          <div className="flex justify-end p-4">
            <Story />
          </div>
        </ShellProvider>
      );
    },
  ],
} satisfies Meta<typeof AccountMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Account menu' });
    await expect(trigger).toHaveTextContent('Aster');
    await expect(trigger).toHaveTextContent('@aster');
    await userEvent.click(trigger);
    if (window.matchMedia('(max-width: 639px)').matches) {
      const dialog = await within(canvasElement.ownerDocument.body).findByRole(
        'dialog',
        { name: 'Account menu' },
        { timeout: 5000 },
      );
      await expect(within(dialog).getByRole('button', { name: 'Switch Agent' })).toBeVisible();
      await expect(within(dialog).getByRole('link', { name: 'Profile' })).toHaveAttribute(
        'href',
        localizedPath(profileHref('aster'), 'en'),
      );
      return;
    }
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    // The Account's own name and email are private: the menu shows only the Agent.
    await expect(menu).not.toHaveTextContent('ada@example.test');
    await expect(menu).not.toHaveTextContent('Ada Lovelace');
    await expect(within(menu).getByRole('group', { name: 'Acting as' })).toHaveTextContent('Aster');
    // The menu opens with a short fade and zoom.
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: 'Switch Agent' })).toBeVisible(),
    );
    await expect(within(menu).getByRole('menuitem', { name: 'Profile' })).toHaveAttribute(
      'href',
      localizedPath(profileHref('aster'), 'en'),
    );
    await expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await expect(
      within(menu).getByRole('menuitem', { name: 'Manage your REZICS Account' }),
    ).toHaveAttribute('href', 'https://account.rezics.test');
    await expect(within(menu).getByRole('menuitem', { name: 'Language: English' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: /^Appearance:/ })).toBeVisible();
  },
};

export const PhoneSecondPanels: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    const trigger = within(canvasElement).getByRole('button', { name: 'Account menu' });
    await userEvent.click(trigger);
    let dialog = await page.findByRole('dialog', { name: 'Account menu' });
    await expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Language: English' }));
    dialog = await page.findByRole('dialog', { name: 'Language' });
    await expect(within(dialog).getAllByRole('radio')).toHaveLength(8);
    const back = within(dialog).getByRole('button', { name: 'Back' });
    await waitFor(() => expect(back).toHaveFocus());
    await userEvent.click(back);
    dialog = await page.findByRole('dialog', { name: 'Account menu' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Language: English' })).toHaveFocus(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /^Appearance:/ }));
    dialog = await page.findByRole('dialog', { name: 'Appearance' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await expect(within(dialog).getByRole('radio', { name: 'Dark' })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    dialog = await page.findByRole('dialog', { name: 'Account menu' });
    await expect(within(dialog).getByRole('button', { name: 'Appearance: Dark' })).toBeVisible();
    await expect(
      within(dialog).getByRole('link', { name: /^Content preferences:/ }),
    ).toHaveAttribute('href', '/en/settings#reading');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const DesktopSubmenus: Story = {
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Account menu' }));
    await chooseMenuItem(page, 'menuitem', 'Language: English');
    await expect(await page.findByRole('menuitemradio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Account menu' }));
    await chooseMenuItem(page, 'menuitem', /^Appearance:/);
    await chooseMenuItem(page, 'menuitemradio', 'Dark');
    await expect(document.documentElement).toHaveClass('dark');
  },
};

export const UnlabeledAgent: Story = {
  args: { session: { ...session, agent: { status: 'selected', agent: agents[1]! } } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Account menu' }),
    ).toHaveTextContent('Agent 1e1489d5');
  },
};

export const BeforeHandle: Story = {
  args: {
    session: {
      ...session,
      agent: {
        status: 'selected',
        agent: { ...agents[0]!, handle: null },
      },
    },
  },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Account menu' });
    await expect(trigger).toHaveTextContent('Choose a handle');
    await expect(trigger).not.toHaveTextContent('@agent-b8df6385');
  },
};

export const ChooseAgent: Story = {
  args: { session: { ...session, agent: { status: 'unselected' } } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Account menu' }),
    ).toHaveTextContent('Choose an Agent');
  },
};

export const AgentNoLongerAvailable: Story = {
  args: { session: { ...session, agent: { status: 'ineligible', previous: pen } } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Account menu' }),
    ).toHaveTextContent('Agent no longer available');
  },
};

export const LongName: Story = {
  args: {
    session: {
      ...session,
      agent: {
        status: 'selected',
        agent: {
          ...agents[0]!,
          label:
            'Augusta Ada King, Countess of Lovelace and Honorary Member of Several Learned Societies',
        },
      },
    },
  },
};

export const Chinese: Story = {
  args: { messages: messages['zh-Hans'], session: { ...session, agent: { status: 'unselected' } } },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: '账户菜单' });
    await expect(trigger).toHaveTextContent('选择身份');
    await userEvent.click(trigger);
    if (window.matchMedia('(max-width: 639px)').matches) {
      const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', {
        name: '账户菜单',
      });
      await expect(within(dialog).getByRole('button', { name: '退出登录' })).toBeVisible();
      return;
    }
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: '退出登录' })).toBeVisible(),
    );
  },
};

/** Every locale exercises the same visible value and accessible name on either viewport. */
const currentValues: Story = {
  async play({ canvasElement, globals }) {
    const locale = isUiLocale(globals.locale) ? globals.locale : 'en';
    const t = messages[locale];
    const shell = { ...shellMessages, ...shellTranslations[locale] };
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: t.accountMenu }));
    const phone = window.matchMedia('(max-width: 639px)').matches;
    const root = await page.findByRole(phone ? 'dialog' : 'menu');
    const rows = within(root);
    // Presence precedes the sheet/menu's opening animation; assert its visible values after it settles.
    await waitFor(() => expect(root).toBeVisible());
    const language = rows.getByRole(phone ? 'button' : 'menuitem', {
      name: accountRowName(t.language, localeNames[locale]),
    });
    await expect(language).toHaveTextContent(`${t.language}·${localeNames[locale]}`);
    await waitFor(() => expect(
      rows.getByRole(phone ? 'button' : 'menuitem', {
        name: accountRowName(t.appearance, shell.themeSystem),
      }),
    ).toBeVisible());
    const content = await rows.findByRole(phone ? 'link' : 'menuitem', {
      name: accountRowName(
        t.contentPreferences,
        contentPreferenceValue(contentPreferences, locale, t),
      ),
    });
    await expect(content).toHaveAttribute('href', `/${locale}/settings#reading`);
    await expect(content.querySelector('.truncate')).toHaveClass('truncate');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const CurrentValuesEnglish: Story = { ...currentValues, globals: { locale: 'en' } };
export const CurrentValuesTraditionalChinese: Story = {
  ...currentValues,
  globals: { locale: 'zh-Hant' },
  args: { messages: messages['zh-Hant'] },
};
export const CurrentValuesSimplifiedChinese: Story = {
  ...currentValues,
  globals: { locale: 'zh-Hans' },
  args: { messages: messages['zh-Hans'] },
};
export const CurrentValuesJapanese: Story = {
  ...currentValues,
  globals: { locale: 'ja' },
  args: { messages: messages.ja },
};
export const CurrentValuesKorean: Story = {
  ...currentValues,
  globals: { locale: 'ko' },
  args: { messages: messages.ko },
};
export const CurrentValuesGerman: Story = {
  ...currentValues,
  globals: { locale: 'de' },
  args: { messages: messages.de },
};
export const CurrentValuesFrench: Story = {
  ...currentValues,
  globals: { locale: 'fr' },
  args: { messages: messages.fr },
};
export const CurrentValuesSpanish: Story = {
  ...currentValues,
  globals: { locale: 'es' },
  args: { messages: messages.es },
};

export const PhoneCurrentValuesEnglish: Story = {
  ...CurrentValuesEnglish,
  globals: { ...CurrentValuesEnglish.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesTraditionalChinese: Story = {
  ...CurrentValuesTraditionalChinese,
  globals: { ...CurrentValuesTraditionalChinese.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesSimplifiedChinese: Story = {
  ...CurrentValuesSimplifiedChinese,
  globals: { ...CurrentValuesSimplifiedChinese.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesJapanese: Story = {
  ...CurrentValuesJapanese,
  globals: { ...CurrentValuesJapanese.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesKorean: Story = {
  ...CurrentValuesKorean,
  globals: { ...CurrentValuesKorean.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesGerman: Story = {
  ...CurrentValuesGerman,
  globals: { ...CurrentValuesGerman.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesFrench: Story = {
  ...CurrentValuesFrench,
  globals: { ...CurrentValuesFrench.globals, viewport: { value: 'phone' } },
};
export const PhoneCurrentValuesSpanish: Story = {
  ...CurrentValuesSpanish,
  globals: { ...CurrentValuesSpanish.globals, viewport: { value: 'phone' } },
};

export const DarkCurrentValue: Story = {
  parameters: { theme: 'dark' },
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Account menu' }));
    const appearance = await page.findByRole('menuitem', { name: 'Appearance: Dark' });
    await waitFor(() => expect(appearance).toBeVisible());
  },
};

export const ContentUnavailable: Story = {
  parameters: { contentUnavailable: true },
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Account menu' }));
    const content = await page.findByRole('menuitem', { name: 'Content preferences: Unavailable' });
    // The item enters the DOM before the menu's opening animation completes.
    await waitFor(() => expect(content).toBeVisible());
    await expect(content).toHaveAttribute('href', '/en/settings#reading');
  },
};
