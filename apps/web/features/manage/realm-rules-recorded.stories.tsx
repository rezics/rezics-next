import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rulesRecord from '../../../../tests/qa/fixtures/outcomes/realm/rules.json';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { realmHref } from '../realm/route.ts';
import { messages } from './messages.ts';
import { accessMessages } from './settings-messages.ts';
import { RealmRulesRecordedPage } from './realm-rules-recorded-page.tsx';

const record = rulesRecord as AnswerRecord;
const managerPrincipal = 'recorded-rules-manager';
const refusedPrincipal = 'recorded-rules-refused';

function sampleOf(persona: AnswerPersona, label: string) {
  const sample = record.personas[persona].find(item => item.label === label);
  if (!sample || !sample.answer || typeof sample.answer !== 'object') throw new Error(`Missing ${persona} sample ${label}`);
  return sample;
}

function recordedName(persona: AnswerPersona, label: string): string {
  const name = (sampleOf(persona, label).answer as { name?: { value?: unknown } }).name?.value;
  if (typeof name !== 'string' || !name) throw new Error(`Recorded ${persona}/${label} has no name`);
  return name;
}

function recordedRuleText(persona: AnswerPersona, label: string): { title: string; body: string } {
  const rules = (sampleOf(persona, label).answer as { rules?: { title?: { value?: unknown }; body?: { value?: unknown } }[] }).rules;
  const rule = rules?.[0];
  if (typeof rule?.title?.value !== 'string' || typeof rule.body?.value !== 'string') {
    throw new Error(`Recorded ${persona}/${label} has no published rule`);
  }
  return { title: rule.title.value, body: rule.body.value };
}

function settingsText(label: string): { body: string; revision: string } {
  const answer = sampleOf('owner', label).answer as {
    ruleBasis?: { revision?: unknown };
    settings?: { rules?: { body?: { labels?: Record<string, string> } }[] };
  };
  const body = answer.settings?.rules?.[0]?.body?.labels?.en;
  if (typeof body !== 'string' || typeof answer.ruleBasis?.revision !== 'string') {
    throw new Error(`Recorded owner/${label} has no settings rule`);
  }
  return { body, revision: answer.ruleBasis.revision };
}

function problemTitle(persona: AnswerPersona, label: string): string {
  const title = (sampleOf(persona, label).answer as { title?: unknown }).title;
  if (typeof title !== 'string') throw new Error(`Recorded ${persona}/${label} has no problem title`);
  return title;
}

function commandEdit(label: string): { en: string; zh: string; reason: string } {
  const body = sampleOf('owner', label).body as {
    reason?: unknown;
    settings?: { rules?: { body?: { labels?: Record<string, string> } }[] };
  };
  const labels = body.settings?.rules?.[0]?.body?.labels;
  if (typeof body.reason !== 'string' || typeof labels?.en !== 'string' || typeof labels['zh-Hans'] !== 'string') {
    throw new Error(`Recorded owner/${label} command has no rule text`);
  }
  return { en: labels.en, zh: labels['zh-Hans'], reason: body.reason };
}

function actingName(label: string): string {
  const name = (sampleOf('owner', label).answer as { displayName?: unknown }).displayName;
  if (typeof name !== 'string' || !name) throw new Error(`Recorded owner/${label} has no display name`);
  return name;
}

function realmOf(persona: AnswerPersona, label: string): string {
  const id = sampleOf(persona, label).path.split('?')[0]?.split('/')[3];
  if (!id) throw new Error(`Recorded ${persona}/${label} has no realm`);
  return decodeURIComponent(id);
}

function actorOf(persona: AnswerPersona, label: string): string {
  const actor = new URL(sampleOf(persona, label).path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!actor) throw new Error(`Recorded ${persona}/${label} has no acting person`);
  return actor;
}

const realm = realmOf('owner', 'rule-settings');
const actor = actorOf('owner', 'rule-settings');

const manager = [
  { label: 'public-rules-en', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'rule-settings', state: 'populated' },
  { label: 'public-page-management-space-direct', state: 'error' },
  { label: 'public-page-management-access-header', state: 'populated' },
  { label: 'public-page-management-space-settings', state: 'populated' },
  { label: 'public-page-management-zone', state: 'error' },
] as const satisfies readonly RecordedSelection[];
const loading = manager.map(selection => selection.label === 'rule-settings'
  ? { ...selection, state: 'loading' as const } : selection);
const refused = [
  ...manager,
  { label: 'rule-intent-conflict', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const meta = {
  title: 'Realm/Recorded rules',
  component: RealmRulesRecordedPage,
  args: {
    record, persona: 'owner' as const, selections: manager, locale: 'en' as const,
    realm, actingSubject: actor, principal: managerPrincipal,
  },
  parameters: { route: { pathname: `/en/manage/r/${realm}/settings` } },
  render: (args, { globals }) => (
    <RealmRulesRecordedPage {...args} locale={isUiLocale(String(globals.locale ?? '')) ? globals.locale as UiLocale : args.locale} />
  ),
} satisfies Meta<typeof RealmRulesRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function localeOf(globals: { locale?: unknown }): UiLocale {
  return isUiLocale(String(globals.locale ?? '')) ? globals.locale as UiLocale : 'en';
}

/**
 * A controlled field drops the tail of a typed string when another render
 * lands between keystrokes. Commit the whole value.
 */
async function typeText(field: () => HTMLElement, text: string) {
  await waitFor(async () => {
    const input = field() as HTMLInputElement | HTMLTextAreaElement;
    if (input.value !== text) {
      await userEvent.click(input);
      await userEvent.clear(input);
      await userEvent.type(input, text);
    }
    await expect(field()).toHaveValue(text);
  }, { timeout: 5000 });
}

async function managerPlay({ canvasElement, globals }: { canvasElement: HTMLElement; globals: { locale?: unknown } }) {
  const canvas = within(canvasElement);
  const locale = localeOf(globals);
  const settings = settingsText('rule-settings');
  const revision = materializeData(messages, { locale }).rulesRevision({ revision: settings.revision });
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('owner', 'public-rules-en') })).resolves.toBeVisible();
  await expect(canvas.getByText(actingName('acting-agent-profile'))).toBeVisible();
  await expect(canvas.getByText(revision)).toBeVisible();
  await expect(within(canvas.getByRole('region', { name: materializeData(messages, { locale }).rulesTitle }))
    .getByRole('heading', { level: 3 })).toHaveTextContent(recordedRuleText('owner', 'public-rules-en').title);
  await expect(canvas.getByText(settings.body)).toBeVisible();
  await expect(canvas.getByRole('button', { name: messages.editRules })).toBeVisible();
}

async function loadingPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent('Loading…');
  await expect(canvas.queryByText(settingsText('rule-settings').body)).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.editRules })).toBeNull();
}

async function refusedPlay({ canvasElement, globals }: { canvasElement: HTMLElement; globals: { locale?: unknown } }) {
  const canvas = within(canvasElement);
  const locale = localeOf(globals);
  const settings = settingsText('rule-settings');
  const revision = materializeData(messages, { locale }).rulesRevision({ revision: settings.revision });
  const command = commandEdit('rule-intent-conflict');
  const t = materializeData(messages, { locale });
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('owner', 'public-rules-en') })).resolves.toBeVisible();
  await expect(canvas.getByText(settings.body)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.editRules }));
  await typeText(() => canvas.getByRole('textbox', { name: t.ruleBodyLabel({ language: t.languageEnglish }) }), command.en);
  await typeText(() => canvas.getByRole('textbox', { name: t.ruleBodyLabel({ language: t.languageChinese }) }), command.zh);
  const rulesPanel = canvas.getByRole('region', { name: t.rulesTitle }).parentElement;
  if (!rulesPanel) throw new Error('The production rules panel has no container');
  await userEvent.click(within(rulesPanel).getByRole('button', { name: t.reviewChanges }));
  const dialog = within(await within(document.body).findByRole('dialog', { name: t.reviewTitle }));
  await typeText(() => dialog.getByRole('textbox', { name: t.publishReasonLabel }), command.reason);
  await userEvent.click(dialog.getByRole('button', { name: t.publish }));
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(problemTitle('owner', 'rule-intent-conflict'));
  await expect(canvas.getByText(settings.body)).toBeVisible();
  await expect(canvas.getByText(revision)).toBeVisible();
  await expect(canvas.queryByText(command.en)).toBeNull();
  await expect(canvas.queryByText(command.zh)).toBeNull();
  await expect(canvas.queryByText(materializeData(messages, { locale }).rulesRevision({
    revision: settingsText('rules-published').revision,
  }))).toBeNull();
}

const managerOwner = { play: managerPlay } satisfies Story;
const loadingOwner = {
  args: { selections: loading, principal: 'recorded-rules-loading' },
  play: loadingPlay,
} satisfies Story;
const refusedOwner = {
  args: { selections: refused, principal: refusedPrincipal },
  play: refusedPlay,
} satisfies Story;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { viewport: { value: viewport } } };
}

export const ManagerOwnerPhone: Story = at(managerOwner, 'phone');
export const ManagerOwnerDesktop: Story = at(managerOwner, 'desktop');
export const LoadingOwnerPhone: Story = at(loadingOwner, 'phone');
export const LoadingOwnerDesktop: Story = at(loadingOwner, 'desktop');
export const RefusedOwnerPhone: Story = at(refusedOwner, 'phone');
export const RefusedOwnerDesktop: Story = at(refusedOwner, 'desktop');

const emptyOwner = {
  args: {
    realm: realmOf('owner', 'empty-page-management-header'),
    actingSubject: actorOf('owner', 'empty-page-management-header'), principal: 'recorded-rules-empty-owner',
    selections: ['header', 'space-direct', 'access-header', 'space-settings', 'rule-settings', 'zone']
      .map(part => `empty-page-management-${part}`).concat('empty-page-acting-agent-profile')
      .map(label => ({ label, state: sampleOf('owner', label).status >= 400 ? 'error' : 'populated' })),
  },
  parameters: { route: { pathname: `/en/manage/r/${realmOf('owner', 'empty-page-management-header')}/settings` } },
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const t = materializeData(messages, { locale: localeOf(globals) });
    await expect(canvas.findByRole('heading', { level: 1, name: recordedName('owner', 'empty-page-management-header') })).resolves.toBeVisible();
    await expect(canvas.getByText(actingName('empty-page-acting-agent-profile'))).toBeVisible();
    const answer = sampleOf('owner', 'empty-page-management-rule-settings').answer as { ruleBasis: { revision: string }; settings: { rules: unknown[] } };
    await expect(answer.settings.rules).toEqual([]);
    await expect(canvas.getByText(t.rulesRevision({ revision: answer.ruleBasis.revision }))).toBeVisible();
    const rules = within(canvas.getByRole('region', { name: t.rulesTitle }));
    await expect(rules.getByText(t.noRulesTitle)).toBeVisible();
    await expect(rules.getByRole('button', { name: t.addRule })).toBeVisible();
    await expect(rules.queryByText(settingsText('rule-settings').body)).toBeNull();
  },
} satisfies Story;
export const EmptyOwnerPhone: Story = at(emptyOwner, 'phone');
export const EmptyOwnerDesktop: Story = at(emptyOwner, 'desktop');

function pageSelections(persona: AnswerPersona, scope: 'public' | 'private', held = false): RecordedSelection[] {
  const labels = [`${scope}-page-frame-address`, `${scope}-page-frame-realm-header`,
    ...scope === 'private' && persona === 'visitor' ? [] : [`${scope}-page-rules-site-link`,
      `${scope}-page-frame-facets`, `${scope}-page-frame-presentation`, `${scope}-page-frame-routes`],
    ...scope === 'private' ? [persona === 'visitor' ? 'private-page-join-page' : 'private-page-rules-header'] : [],
    ...persona !== 'visitor' ? ['joining', 'follow', 'platform-access', 'member-ban', 'session-agent', 'person-preferences']
      .map(part => `${scope}-page-frame-${part}`) : []];
  return labels.map(label => ({ label, state: held && label === `${scope}-page-frame-realm-header` ? 'loading'
    : sampleOf(persona, label).status >= 400 ? 'error' : 'populated' }));
}

function publicPage(persona: AnswerPersona, scope: 'public' | 'private', held = false): Story {
  const key = new URL(sampleOf(persona, `${scope}-page-frame-address`).path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded frame address has no key');
  return {
    args: { persona, page: 'rules', realm: key, actingSubject: persona === 'visitor' ? ''
      : actorOf(persona, `${scope}-page-management-header`), selections: pageSelections(persona, scope, held),
      principal: `recorded-rules-${scope}-${persona}` },
    parameters: { route: { pathname: realmHref('en', key, 'rules') } },
    play: held ? loadingPlay : async ({ canvasElement, globals }) => {
      const canvas = within(canvasElement);
      const label = scope === 'private' && persona !== 'visitor' ? 'private-page-rules-header' : `${scope}-page-frame-realm-header`;
      const nameLabel = scope === 'private' && persona === 'visitor' ? 'private-page-join-page' : label;
      await expect(canvas.findByRole('heading', { level: 1, name: recordedName(persona, nameLabel) })).resolves.toBeVisible();
      const text = recordedRuleText(persona, nameLabel);
      await expect(canvas.getByRole('heading', { name: name => name.includes(text.title) })).toBeVisible();
      await expect(canvas.getByText(text.body)).toBeVisible();
      await expect(canvas.queryByRole('button', { name: messages.editRules })).toBeNull();
      if (scope === 'private' && persona === 'visitor') {
        await expect(canvas.getByRole('alert')).toHaveTextContent(problemTitle(persona, 'private-page-frame-realm-header'));
        await expect(canvas.getByRole('alert')).toHaveAttribute('data-status', '404');
        await expect(canvas.getByRole('alert')).toHaveAttribute('data-problem-code', 'realm_unavailable');
        await expect(canvas.getByRole('link', { name: accessMessages[localeOf(globals)].signIn })).toBeVisible();
      }
    },
  };
}

function deniedSettings(persona: 'stranger' | 'member' | 'moderator' | 'operator'): Story {
  const labels = ['public-page-management-header', 'public-page-management-space-direct',
    'public-page-management-access-header', 'public-page-management-space-settings',
    'public-page-management-zone', 'public-page-acting-agent-profile'];
  return {
    args: { persona, realm, actingSubject: actorOf(persona, 'public-page-management-header'),
      principal: `recorded-rules-denied-${persona}`, selections: labels.map(label => ({ label,
        state: sampleOf(persona, label).status >= 400 ? 'error' : 'populated' })) },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.findByRole('heading', { level: 1, name: recordedName(persona, 'public-page-management-header') })).resolves.toBeVisible();
      const name = (sampleOf(persona, 'public-page-acting-agent-profile').answer as { displayName: string }).displayName;
      await expect(canvas.getByText(name)).toBeVisible();
      const refused = sampleOf(persona, 'public-page-management-space-settings');
      const problem = refused.answer as { title: string; code: string };
      await expect(canvas.getByRole('alert')).toHaveTextContent(problem.title);
      await expect(canvas.getByRole('alert')).toHaveAttribute('data-status', String(refused.status));
      await expect(canvas.getByRole('alert')).toHaveAttribute('data-problem-code', problem.code);
      await expect(canvas.queryByRole('button', { name: messages.editRules })).toBeNull();
      await expect(canvas.queryByText(settingsText('rule-settings').body)).toBeNull();
      await waitFor(() => expect(canvas.queryByRole('link', { name: messages.tabSettings })).toBeNull());
    },
  };
}

export const PublishedVisitorPhone: Story = at(publicPage('visitor', 'public'), 'phone');
export const PublishedVisitorDesktop: Story = at(publicPage('visitor', 'public'), 'desktop');
export const PublishedLoadingVisitorPhone: Story = at(publicPage('visitor', 'public', true), 'phone');
export const PublishedLoadingVisitorDesktop: Story = at(publicPage('visitor', 'public', true), 'desktop');
export const PrivateVisitorPhone: Story = at(publicPage('visitor', 'private'), 'phone');
export const PrivateVisitorDesktop: Story = at(publicPage('visitor', 'private'), 'desktop');
export const PrivateMemberPhone: Story = at(publicPage('member', 'private'), 'phone');
export const PrivateMemberDesktop: Story = at(publicPage('member', 'private'), 'desktop');
export const PrivateModeratorPhone: Story = at(publicPage('moderator', 'private'), 'phone');
export const PrivateModeratorDesktop: Story = at(publicPage('moderator', 'private'), 'desktop');
export const DeniedStrangerPhone: Story = at(deniedSettings('stranger'), 'phone');
export const DeniedStrangerDesktop: Story = at(deniedSettings('stranger'), 'desktop');
export const DeniedMemberPhone: Story = at(deniedSettings('member'), 'phone');
export const DeniedMemberDesktop: Story = at(deniedSettings('member'), 'desktop');
export const DeniedModeratorPhone: Story = at(deniedSettings('moderator'), 'phone');
export const DeniedModeratorDesktop: Story = at(deniedSettings('moderator'), 'desktop');
export const DeniedOperatorPhone: Story = at(deniedSettings('operator'), 'phone');
export const DeniedOperatorDesktop: Story = at(deniedSettings('operator'), 'desktop');
