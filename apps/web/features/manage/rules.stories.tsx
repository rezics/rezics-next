import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, adminApi, type AdminRecord, header, realm, rules, settings } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmFrame } from './realm-frame.tsx';
import { SettingsView } from './settings-view.tsx';

// Realm rules have one approved meaning, the published revision moderators
// cite, and localized forms readers see. These stories hold that behavior:
// the reader's language never changes the revision, a missing language falls
// back explicitly, every edit publishes a new revision, and a concurrent
// publication keeps the draft instead of overwriting anyone.

const record: AdminRecord = { members: [], roles: [], settings: [] };
const chinese = { ...messages, ...zhHans };

const meta = {
  title: 'Manage/Settings and rules',
  component: SettingsView,
  parameters: { route: { pathname: `/en/manage/r/${realm}/settings` } },
  args: { realm, actingSubject: acting.iri, initial: settings, locale: 'en', messages, api: adminApi({ record }) },
  beforeEach: () => {
    record.settings.length = 0;
    localStorage.removeItem(`rezics:manage:rules-draft:${realm}`);
    return () => localStorage.removeItem(`rezics:manage:rules-draft:${realm}`);
  },
  render: (args: ComponentProps<typeof SettingsView>) => <RealmFrame realm={realm} header={header} agent={acting}
    locale={args.locale} messages={args.messages}><SettingsView {...args} /></RealmFrame>,
} satisfies Meta<typeof SettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = () => within(document.body);
const firstRule = (canvas: ReturnType<typeof within>) => canvas.getAllByRole('heading', { level: 3 })[0]!;

export const PublishedRules: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Revision 3')).toBeVisible();
    await expect(firstRule(canvas)).toHaveTextContent('No spoilers in titles');
    await expect(firstRule(canvas)).toHaveAttribute('lang', 'en');
    await expect(canvas.queryByText(/shown in/)).toBeNull();
    await expect(canvas.getByRole('radio', { name: /Realm members/ })).toBeChecked();
  },
};

/** A Chinese reader reads the Chinese form of the same revision. */
export const ChineseReader: Story = {
  args: { locale: 'zh-Hans', messages: chinese },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}/settings` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('第 3 版')).toBeVisible();
    await expect(firstRule(canvas)).toHaveTextContent('标题中不要剧透');
    await expect(firstRule(canvas)).toHaveAttribute('lang', 'zh-Hans');
  },
};

/** No Japanese form exists: the page says which language it shows, and the revision is unchanged. */
export const JapaneseReaderFallsBack: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja' },
  parameters: { route: { pathname: `/ja/manage/r/${realm}/settings` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Revision 3')).toBeVisible();
    await expect(firstRule(canvas)).toHaveAttribute('lang', 'en');
    await expect(canvas.getAllByText('No 日本語 version · shown in English')).toHaveLength(rules.length);
  },
};

/** An unavailable script falls back to the recorded original. */
export const TraditionalReaderSeesOriginal: Story = {
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  parameters: { route: { pathname: `/zh-Hant/manage/r/${realm}/settings` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(firstRule(canvas)).toHaveAttribute('lang', 'en');
    await expect(canvas.getAllByText('No 繁體中文 version · shown in English')).toHaveLength(rules.length);
  },
};

/** An edit in one language is tracked on its own and flags the other to check; publishing makes revision 4. */
export const EditOneLanguage: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit rules' }));
    const title = canvas.getAllByRole('textbox', { name: 'Title in Simplified Chinese' })[0]!;
    await expect(title).toHaveAttribute('lang', 'zh-Hans');
    await userEvent.clear(title);
    await userEvent.type(title, '标题和封面语中不要剧透');
    const rule = canvas.getByRole('heading', { name: 'Rule 1' }).closest('li')!;
    await expect(within(rule).getByText('Edited')).toBeInTheDocument();
    await expect(within(rule).getByText('Check wording')).toBeInTheDocument();
    await expect(rule).toHaveTextContent('Only Simplified Chinese changed. Check that English still says the same.');
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Review before publishing' }, { timeout: 5000 }));
    await expect(dialog.getByText(/Changes “No spoilers in titles” in Simplified Chinese/)).toBeInTheDocument();
    await expect(dialog.getByText(/Publishing creates revision 4/)).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'What changed and why' }), 'Cover lines count as titles.');
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await expect(await canvas.findByText('Revision 4 is published.')).toBeVisible();
    await expect(record.settings).toEqual([expect.objectContaining({ expectedRulesRevision: '3', expectedGeneration: '12',
      reason: 'Cover lines count as titles.', settings: expect.objectContaining({ whoMaySubmit: 'members',
        rules: [expect.objectContaining({ id: 'no-spoilers', title: { original: 'en', labels: { en: 'No spoilers in titles', 'zh-Hans': '标题和封面语中不要剧透' } } }),
          rules[1], rules[2]] }) })]);
  },
};

/** New text has unknown language; it needs a title and body, not invented translations. */
export const NewRuleWithoutInventedTranslations: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit rules' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add a rule' }));
    const added = canvas.getByRole('heading', { name: 'Rule 4' }).closest('li')!;
    const title = within(added).getByRole('textbox', { name: 'Title in Unknown language' });
    await expect(title).toHaveAttribute('lang', 'und');
    await userEvent.type(title, 'Credit the translator');
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    await expect(within(added).getByText('Write the explanation in Unknown language.')).toBeInTheDocument();
    await expect(body().queryByRole('dialog')).toBeNull();
    await userEvent.type(within(added).getByRole('textbox', { name: 'Explanation in Unknown language' }),
      'Name who translated a text when it is known.');
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Review before publishing' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'What changed and why' }), 'Credit translators.');
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await expect(record.settings[0]).toMatchObject({ settings: { rules: [...rules,
      { id: 'credit-the-translator', governanceRule: null,
        title: { original: 'und', labels: { und: 'Credit the translator' } },
        body: { original: 'und', labels: { und: 'Name who translated a text when it is known.' } } }] } });
  },
};

const theirs = { ...settings, generation: '14', ruleBasis: { ...settings.ruleBasis, revision: '4', digest: 'd'.repeat(64) },
  settings: { ...settings.settings, rules: [...rules.slice(0, 2), { ...rules[2]!,
    body: { original: 'en', labels: { en: 'Criticise readings and translations, never the people who made them.',
      'zh-Hans': '批评解读和译文，不要针对做出它们的人。' } } }] } };

/** Someone published while this draft was open: the draft is kept and compared, never overwritten. */
export const ConcurrentPublicationKeepsDraft: Story = {
  args: { api: adminApi({ record, settingsFailure: 'stale', theirs }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit rules' }));
    const body0 = canvas.getAllByRole('textbox', { name: 'Explanation in English' })[1]!;
    await userEvent.type(body0, ' Include the publisher.');
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Review before publishing' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'What changed and why' }), 'Publishers too.');
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    const conflict = await canvas.findByText('Someone else published first');
    await expect(conflict.closest('[role=alert]') ?? conflict.parentElement!).toHaveTextContent(
      'Revision 4 was published while you were editing. Your draft is kept.');
    await expect(canvas.getByRole('region', { name: 'Published now' })).toHaveTextContent('never the people who made them');
    await expect(canvas.getByRole('region', { name: 'Your draft' })).toHaveTextContent('Changes “Name the edition” in English');
    await expect(canvas.getAllByRole('textbox', { name: 'Explanation in English' })[1]).toHaveValue(
      `${rules[1]!.body.labels.en} Include the publisher.`);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish my draft on top' }));
    const again = within(await body().findByRole('dialog', { name: 'Review before publishing' }, { timeout: 5000 }));
    await expect(again.getByText(/Publishing creates revision 5/)).toBeInTheDocument();
  },
};

/** A draft survives a reload until it is published or discarded. */
export const DraftSurvivesReload: Story = {
  beforeEach: () => {
    localStorage.setItem(`rezics:manage:rules-draft:${realm}`, JSON.stringify({ base: '3', whoMaySubmit: 'closed',
      drafts: rules.slice(0, 1).map(rule => ({ key: rule.id, rule, published: true })) }));
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('radio', { name: /No one/ })).toBeChecked());
    await expect(canvas.getAllByRole('heading', { name: /^Rule \d$/ })).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Discard changes' }));
    await expect(canvas.getByRole('radio', { name: /Realm members/ })).toBeChecked();
    await expect(localStorage.getItem(`rezics:manage:rules-draft:${realm}`)).toBeNull();
  },
};

/** Text in a right-to-left script keeps its own direction. */
export const RightToLeftText: Story = {
  args: { initial: { ...settings, settings: { ...settings.settings, rules: [{ id: 'arabic-sources', governanceRule: null,
    title: { original: 'ar', labels: { ar: 'اذكر المصدر', 'zh-Hans': '注明来源' } },
    body: { original: 'ar', labels: { ar: 'اذكر الترجمة والطبعة.', 'zh-Hans': '注明译本和版本。' } } }] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(firstRule(canvas)).toHaveAttribute('lang', 'ar');
    await expect(firstRule(canvas)).toHaveAttribute('dir', 'auto');
    await userEvent.click(canvas.getByRole('button', { name: 'Edit rules' }));
    await expect(canvas.getByRole('textbox', { name: 'Title in Arabic' })).toHaveAttribute('lang', 'ar');
  },
};

export const ChineseEditing: Story = {
  args: { locale: 'zh-Hans', messages: chinese },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}/settings` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '编辑规则' }));
    await expect(canvas.getAllByRole('textbox', { name: '简体中文标题' })).toHaveLength(rules.length);
  },
};

export const DarkPhoneEditing: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit rules' }));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
