import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import games from '../../../../tests/qa/fixtures/outcomes/games/work-hub-and-edition-choice.json';
import type { UiLocale } from '../../i18n/define.ts';
import { chooseOption } from '../stories/choose-option.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import type { Release } from '../tracking/types.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { GamesHubRecordedPage } from './games-hub-recorded-page.tsx';
import { messages } from './messages.ts';

const record = games as AnswerRecord;
type Persona = 'visitor' | 'member';
type Mode = 'populated' | 'loading' | 'saved';
interface Args { persona: Persona; mode: Mode; locale: UiLocale }

const sample = (persona: AnswerPersona, label: string) => {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing Games answer: ${persona}/${label}`);
  return found;
};

const meta = { title: 'Work page/Games hub recorded', component: GamesHubRecordedPage,
  args: { record, persona: 'visitor', mode: 'populated', locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { controls: { disable: true } },
} satisfies Meta<typeof GamesHubRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;

function releaseOf(persona: AnswerPersona) {
  const page = sample(persona, 'hub-releases').answer as { items: Release[] };
  const release = page.items[0];
  if (!release) throw new Error(`Missing recorded Games release: ${persona}`);
  return release;
}

async function expectTitle(canvasElement: HTMLElement, persona: Persona) {
  const header = sample(persona, 'work-header').answer as { title: { value: string } };
  await expect(within(canvasElement).findByRole('heading', { level: 1, name: header.title.value })).resolves.toBeVisible();
  return header;
}

async function expectReleaseLink(canvasElement: HTMLElement, persona: Persona, locale: UiLocale) {
  const release = releaseOf(persona);
  const canvas = within(canvasElement);
  const list = canvas.getByRole('list', { name: levelsCopy(locale).releases });
  await expect(within(list).getByRole('link', { name: release.title.value })).toBeVisible();
  return release;
}

async function expectNoOverflow() {
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const Visitor: Story = { async play({ canvasElement, args }) {
  await expectTitle(canvasElement, args.persona);
  await expectReleaseLink(canvasElement, args.persona, args.locale);
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('link', { name: messages[args.locale].signInForEdition })).toBeVisible();
  await expect(canvas.getByRole('link', { name: messages[args.locale].startReading })).toBeVisible();
  await expect(canvas.queryByRole('button', { name: trackingCopy(args.locale).savePreference })).not.toBeInTheDocument();
  await expect(canvas.queryByRole('list', { name: messages[args.locale].yourEdition })).not.toBeInTheDocument();
  await expectNoOverflow();
} };
export const VisitorPhone: Story = { ...Visitor, globals: phone };
export const VisitorChinese: Story = { ...Visitor, args: { record, persona: 'visitor', mode: 'populated', locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' } };
export const VisitorChinesePhone: Story = { ...VisitorChinese, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const Loading: Story = { args: { mode: 'loading' }, async play({ canvasElement, args }) {
  await expect(within(canvasElement).getByRole('status')).toHaveTextContent(messages[args.locale].loading);
  await expect(within(canvasElement).queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };

async function expectChooser(canvasElement: HTMLElement, args: Args, saved: boolean) {
  await expectTitle(canvasElement, args.persona);
  const release = await expectReleaseLink(canvasElement, args.persona, args.locale);
  const canvas = within(canvasElement);
  const tracking = trackingCopy(args.locale);
  const name = releaseChoiceName(release, args.locale, tracking);
  const edition = await canvas.findByRole('combobox', { name: tracking.edition });
  if (saved) await expect(edition).toHaveTextContent(release.title.value);
  else await expect(edition).toHaveTextContent(tracking.anyEdition);
  await userEvent.click(edition);
  // The option is in the tree while the menu is still entering.
  await waitFor(() => expect(canvas.getByRole('option', { name })).toBeVisible());
  await expect(canvas.queryByRole('list', { name: messages[args.locale].yourEdition })).not.toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await expect(canvas.getByRole('link', { name: messages[args.locale].startReading })).toBeVisible();
  await expectNoOverflow();
  return { canvas, tracking, name };
}

export const Member: Story = { args: { persona: 'member', mode: 'populated' }, async play({ canvasElement, args }) {
  const { canvas, tracking, name } = await expectChooser(canvasElement, args, false);
  await userEvent.click(canvas.getByRole('combobox', { name: tracking.edition }));
  await chooseOption(canvas, name);
  await userEvent.click(canvas.getByRole('button', { name: tracking.savePreference }));
  await expect(canvas.findByText(tracking.preferenceSaved)).resolves.toBeVisible();
  await expectNoOverflow();
} };
export const MemberPhone: Story = { ...Member, globals: phone };

export const MemberSaved: Story = { args: { persona: 'member', mode: 'saved' }, async play({ canvasElement, args }) {
  await expectChooser(canvasElement, args, true);
} };
export const MemberSavedPhone: Story = { ...MemberSaved, globals: phone };
