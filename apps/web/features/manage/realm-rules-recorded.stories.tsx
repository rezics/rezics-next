import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rulesRecord from '../../../../tests/qa/fixtures/outcomes/realm/rules.json';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { realmHref } from '../realm/route.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { accessMessages } from './settings-messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages } from './messages.ts';
import { RealmRulesRecordedPage } from './realm-rules-recorded-page.tsx';
import { uuidOf } from './types.ts';

const record = rulesRecord as AnswerRecord;

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

function commandText(label: string): string {
  const body = sampleOf('owner', label).body as { settings?: { rules?: { body?: { labels?: Record<string, string> } }[] } };
  const text = body.settings?.rules?.[0]?.body?.labels?.en;
  if (typeof text !== 'string') throw new Error(`Recorded owner/${label} command has no rule text`);
  return text;
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

function joinRealm(label: string): string {
  const id = (sampleOf('visitor', label).answer as { id?: unknown }).id;
  if (typeof id !== 'string') throw new Error(`Recorded visitor/${label} has no id`);
  return uuidOf(id);
}

const populated = [{ label: 'public-rules-en', state: 'populated' }] as const satisfies readonly RecordedSelection[];
const empty = [{ label: 'rules-empty', state: 'empty' }] as const satisfies readonly RecordedSelection[];
const landing = [
  { label: 'private-rules-zh', state: 'error' },
  { label: 'private-request-landing', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const refusal = [{ label: 'rule-settings-denied', state: 'error' }] as const satisfies readonly RecordedSelection[];
const loading = [{ label: 'public-rules-en', state: 'loading' }] as const satisfies readonly RecordedSelection[];
const manager = [
  { label: 'public-rules-en', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'rule-settings', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const refused = [
  { label: 'public-rules-en', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'rule-settings', state: 'populated' },
  { label: 'rule-intent-conflict', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const meta = {
  title: 'Realm/Recorded rules',
  component: RealmRulesRecordedPage,
  args: { record, persona: 'visitor' as const, selections: populated, locale: 'en' as const },
  render: (args, { globals }) => (
    <RealmRulesRecordedPage {...args} locale={isUiLocale(String(globals.locale ?? '')) ? globals.locale as UiLocale : args.locale} />
  ),
} satisfies Meta<typeof RealmRulesRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function localeOf(globals: { locale?: unknown }): UiLocale {
  return isUiLocale(String(globals.locale ?? '')) ? globals.locale as UiLocale : 'en';
}

async function publishedPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const rule = recordedRuleText('visitor', 'public-rules-en');
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('visitor', 'public-rules-en') })).resolves.toBeVisible();
  await expect(canvas.getByRole('heading', { level: 2, name: realmMessages.rules })).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 3 })).toHaveTextContent(rule.title);
  await expect(canvas.getByText(rule.body)).toBeVisible();
}

async function emptyPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const absent = recordedRuleText('visitor', 'public-rules-en').title;
  const rules = (sampleOf('owner', 'rules-empty').answer as { rules?: unknown }).rules;
  if (!Array.isArray(rules) || rules.length !== 0) throw new Error('owner rules-empty is not an empty list');
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('owner', 'rules-empty') })).resolves.toBeVisible();
  await expect(canvas.getByText(realmMessages.noRules)).toBeVisible();
  await expect(canvas.queryByText(absent)).toBeNull();
}

async function landingPlay({ canvasElement, globals }: { canvasElement: HTMLElement; globals: { locale?: unknown } }) {
  const canvas = within(canvasElement);
  const locale = localeOf(globals);
  const rule = recordedRuleText('visitor', 'private-request-landing');
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('visitor', 'private-request-landing') })).resolves.toBeVisible();
  await expect(canvas.getByRole('heading', { level: 3, name: rule.title })).toBeVisible();
  await expect(canvas.getByText(rule.body)).toBeVisible();
  await expect(canvas.getByRole('link', { name: accessMessages[locale].signIn })).toHaveAttribute('href',
    signInPath(realmHref(locale, joinRealm('private-request-landing'), 'rules')));
  await expect(canvas.queryByText(problemTitle('visitor', 'private-rules-zh'))).toBeNull();
}

async function refusalPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const title = problemTitle('visitor', 'rule-settings-denied');
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(title);
  await expect(canvas.queryByText(recordedRuleText('visitor', 'public-rules-en').title)).toBeNull();
  await expect(canvas.queryByText(recordedRuleText('visitor', 'public-rules-en').body)).toBeNull();
}

async function loadingPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
  await expect(canvas.queryByText(recordedRuleText('visitor', 'public-rules-en').body)).toBeNull();
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

async function refusedPlay({ canvasElement, globals }: { canvasElement: HTMLElement; globals: { locale?: unknown } }) {
  const canvas = within(canvasElement);
  const locale = localeOf(globals);
  const settings = settingsText('rule-settings');
  const revision = materializeData(messages, { locale }).rulesRevision({ revision: settings.revision });
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(problemTitle('owner', 'rule-intent-conflict'));
  await expect(canvas.getByText(settings.body)).toBeVisible();
  await expect(canvas.getByText(revision)).toBeVisible();
  await expect(canvas.queryByText(commandText('rule-intent-conflict'))).toBeNull();
  await expect(canvas.queryByText(materializeData(messages, { locale }).rulesRevision({
    revision: settingsText('rules-published').revision,
  }))).toBeNull();
}

const populatedVisitor = {
  parameters: { route: { pathname: `/en/r/${realmOf('visitor', 'public-rules-en')}/rules` } },
  play: publishedPlay,
} satisfies Story;
const emptyOwner = {
  args: { persona: 'owner' as const, selections: empty },
  parameters: { route: { pathname: `/en/r/${realmOf('owner', 'rules-empty')}/rules` } },
  play: emptyPlay,
} satisfies Story;
const landingVisitor = {
  args: { selections: landing },
  parameters: { route: { pathname: `/en/r/${realmOf('visitor', 'private-request-landing')}/rules` } },
  play: landingPlay,
} satisfies Story;
const refusalVisitor = {
  args: { selections: refusal },
  parameters: { route: { pathname: `/en/manage/r/${realmOf('visitor', 'rule-settings-denied')}/settings` } },
  play: refusalPlay,
} satisfies Story;
const loadingVisitor = {
  args: { selections: loading },
  parameters: { route: { pathname: `/en/r/${realmOf('visitor', 'public-rules-en')}/rules` } },
  play: loadingPlay,
} satisfies Story;
const managerOwner = {
  args: { persona: 'owner' as const, selections: manager },
  parameters: { route: { pathname: `/en/manage/r/${realmOf('owner', 'rule-settings')}/settings` } },
  play: managerPlay,
} satisfies Story;
const refusedOwner = {
  args: { persona: 'owner' as const, selections: refused },
  parameters: { route: { pathname: `/en/manage/r/${realmOf('owner', 'rule-intent-conflict')}/settings` } },
  play: refusedPlay,
} satisfies Story;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { viewport: { value: viewport } } };
}

export const PopulatedVisitorPhone: Story = at(populatedVisitor, 'phone');
export const PopulatedVisitorDesktop: Story = at(populatedVisitor, 'desktop');
export const EmptyOwnerPhone: Story = at(emptyOwner, 'phone');
export const EmptyOwnerDesktop: Story = at(emptyOwner, 'desktop');
export const LandingVisitorPhone: Story = at(landingVisitor, 'phone');
export const LandingVisitorDesktop: Story = at(landingVisitor, 'desktop');
export const RefusalVisitorPhone: Story = at(refusalVisitor, 'phone');
export const RefusalVisitorDesktop: Story = at(refusalVisitor, 'desktop');
export const LoadingVisitorPhone: Story = at(loadingVisitor, 'phone');
export const LoadingVisitorDesktop: Story = at(loadingVisitor, 'desktop');
export const ManagerOwnerPhone: Story = at(managerOwner, 'phone');
export const ManagerOwnerDesktop: Story = at(managerOwner, 'desktop');
export const RefusedOwnerPhone: Story = at(refusedOwner, 'phone');
export const RefusedOwnerDesktop: Story = at(refusedOwner, 'desktop');
