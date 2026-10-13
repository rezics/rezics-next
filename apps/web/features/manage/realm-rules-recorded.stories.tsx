import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rulesRecord from '../../../../tests/qa/fixtures/outcomes/realm/rules.json';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages } from './messages.ts';
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
] as const satisfies readonly RecordedSelection[];
const loading = [
  { label: 'public-rules-en', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'rule-settings', state: 'loading' },
] as const satisfies readonly RecordedSelection[];
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
  await expect(canvas.getByRole('heading', { level: 3 })).toHaveTextContent(recordedRuleText('owner', 'public-rules-en').title);
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
  await userEvent.click(canvas.getByRole('button', { name: t.reviewChanges }));
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
