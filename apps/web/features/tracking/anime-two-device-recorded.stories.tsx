import { materializeData } from 'native-i18n';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { copyOf } from './messages.ts';
import { AnimeTwoDeviceRecordedPage } from './anime-two-device-recorded-page.tsx';
import { recordedSample, type AnimeChain, type SignedInPersona } from './anime-two-device-recorded-page.ts';

interface Props {
  persona: AnswerPersona;
  locale?: UiLocale;
  hold?: boolean;
  direction?: AnimeChain;
}

const meta = {
  title: 'Tracking/Anime two-device progress recorded',
  component: AnimeTwoDeviceRecordedPage,
  args: { persona: 'stranger', locale: 'en', hold: false, direction: 'mark' },
  globals: { viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof AnimeTwoDeviceRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

interface ResumeAnswer {
  scope?: string;
  complete?: boolean;
  items?: { displayLabel?: string }[];
}
interface StructureAnswer {
  occurrences: { qualifier?: { displayLabel?: string } }[];
}
interface ProgressAnswer {
  completed: boolean;
  position: string | null;
}
interface WriteBody {
  completed: boolean;
  position: string | null;
}

function personaLabel(persona: AnswerPersona): string {
  return persona[0]!.toUpperCase() + persona.slice(1);
}

function episodeNumber(position: string): string {
  const match = /^(?:episode|special):(\d+)$/.exec(position);
  if (!match?.[1]) throw new Error(`Recorded position has no episode number: ${position}`);
  return match[1];
}

function labelAt(persona: SignedInPersona, index: number): string {
  const label = (recordedSample(persona, 'episode-structure').answer as StructureAnswer)
    .occurrences[index]?.qualifier?.displayLabel;
  if (!label) throw new Error(`Recorded episode ${index} has no display label`);
  return label;
}

function placeOf(persona: SignedInPersona, label: string): string | null {
  const answer = recordedSample(persona, label).answer as ResumeAnswer;
  if (answer.scope !== 'resume' || answer.complete !== true) return null;
  const place = answer.items?.[0]?.displayLabel;
  if (!place) throw new Error(`Recorded resume ${label} has no place`);
  return place;
}

async function jump(region: HTMLElement, locale: UiLocale, number: string) {
  const canvas = within(region);
  const copy = copyOf(locale);
  const field = await canvas.findByRole('textbox', { name: copy.jumpTo });
  await userEvent.clear(field);
  await userEvent.type(field, number);
  await userEvent.click(canvas.getByRole('button', { name: copy.jumpGo }));
}

async function expectSelected(
  region: HTMLElement,
  label: string,
  state: 'done' | 'open',
  text: string,
) {
  await waitFor(async () => {
    const selected = region.querySelector('[data-selected]');
    await expect(selected).toHaveTextContent(label);
    await expect(selected?.querySelector(`[data-state="${state}"]`)).toHaveTextContent(text);
  });
}

async function expectWhere(region: HTMLElement, text: string) {
  await waitFor(() => expect(region.querySelector('[data-where]')).toHaveTextContent(text));
}

async function expectNoOverflow(canvasElement: HTMLElement) {
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

async function playVisitor({ canvasElement, args }: { canvasElement: HTMLElement; args: Props }) {
  const canvas = within(canvasElement);
  const locale = args.locale ?? 'en';
  const title = (recordedSample('visitor', 'work-header').answer as { title: { value: string } })
    .title.value;
  const author = (
    recordedSample('visitor', 'agent-credits').answer as { items: { displayName: string }[] }
  ).items[0]!.displayName;
  const page = materializeData(workMessages[locale], { locale });
  await expect(canvas.findByRole('heading', { level: 1, name: title })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: author })).resolves.toBeVisible();
  await expect(canvas.findByText('Visitor')).resolves.toBeVisible();
  await expect(canvas.findByRole('region', { name: page.adoption })).resolves.toBeVisible();
  await expect(canvas.findByText(page.notAdopted)).resolves.toBeVisible();
  await expect(canvas.queryByRole('heading', { name: 'Episodes' })).not.toBeInTheDocument();
  await expect(canvas.queryByText('First device')).not.toBeInTheDocument();
  await expect(canvas.queryByText(relationshipMessages[locale].unknown)).not.toBeInTheDocument();
  await expectNoOverflow(canvasElement);
  await expect(args.persona).toBe('visitor');
}

async function playDevices({
  canvasElement,
  args,
  parameters,
}: {
  canvasElement: HTMLElement;
  args: Props;
  parameters: { until?: 'conflict' };
}) {
  const canvas = within(canvasElement);
  const locale = args.locale ?? 'en';
  const copy = copyOf(locale);
  const persona = args.persona;
  if (persona === 'visitor') return playVisitor({ canvasElement, args });
  const direction = args.direction ?? 'mark';
  const title = (recordedSample(persona, 'work-header').answer as { title: { value: string } })
    .title.value;
  const author = (
    recordedSample(persona, 'agent-credits').answer as { items: { displayName: string }[] }
  ).items[0]!.displayName;
  const actingSubject = new URL(
    recordedSample(persona, 'work-header').path,
    'https://recorded.invalid',
  ).searchParams.get('actingSubject')!;
  await expect(canvas.findByRole('heading', { level: 1, name: title })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: author })).resolves.toBeVisible();
  await expect(canvas.findByText(actingSubject)).resolves.toBeVisible();
  await expect(canvas.findByText(personaLabel(persona))).resolves.toBeVisible();
  const page = materializeData(workMessages[locale], { locale });
  await expect(canvas.findByRole('region', { name: page.adoption })).resolves.toBeVisible();
  await expect(canvas.findByText(page.notAdopted)).resolves.toBeVisible();
  const follow = relationshipMessages[locale].follow;
  await expect(canvas.findByRole('button', { name: new RegExp(follow) })).resolves.toBeVisible();
  await expect(canvas.queryByText(relationshipMessages[locale].unknown)).not.toBeInTheDocument();

  const opening = recordedSample(persona, `reachable-${direction}-first-device-progress-1`).answer as ProgressAnswer;
  const body = recordedSample(persona, `reachable-${direction}-first-device-write-1`).body as WriteBody;
  if (!body.position) throw new Error(`Recorded ${direction} write has no position`);
  const number = episodeNumber(body.position);
  const episodeLabel = labelAt(persona, Number(number) - 1);
  const before = (device: 'first' | 'second') => placeOf(
    persona,
    direction === 'mark' ? 'episode-resume' : `reachable-mark-${device}-device-resume-1`,
  );
  const after = (device: 'first' | 'second') =>
    placeOf(persona, `reachable-${direction}-${device}-device-resume-1`);
  const where = (place: string | null) => place ? copy.lastWatched({ place }) : copy.unknown;
  const action = opening.completed ? copy.markNotWatched : copy.markWatched;
  const opened = opening.completed ? copy.watched : copy.notWatched;
  const openedState = opening.completed ? 'done' : 'open';

  const first = await canvas.findByRole('region', { name: 'First device' });
  const firstCanvas = within(first);
  await firstCanvas.findByRole('textbox', { name: copy.jumpTo });
  await expectWhere(first, where(before('first')));
  if (args.hold) {
    const second = await canvas.findByRole('region', { name: 'Second device' });
    const secondCanvas = within(second);
    await expect(secondCanvas.findByRole('heading', { name: copy.episodes })).resolves.toBeVisible();
    await expect(second).toHaveAttribute('data-pending');
    await expect(secondCanvas.queryByRole('textbox', { name: copy.jumpTo })).not.toBeInTheDocument();
    await expectNoOverflow(canvasElement);
    return;
  }

  await jump(first, locale, number);
  await expectSelected(first, episodeLabel, openedState, opened);
  await userEvent.click(firstCanvas.getByRole('button', { name: action }));
  await expectWhere(first, where(after('first')));

  const second = await canvas.findByRole('region', { name: 'Second device' });
  const secondCanvas = within(second);
  await secondCanvas.findByRole('textbox', { name: copy.jumpTo });
  await expectWhere(second, where(before('second')));
  await jump(second, locale, number);
  await expectSelected(second, episodeLabel, openedState, opened);
  await userEvent.click(secondCanvas.getByRole('button', { name: action }));
  const alert = await secondCanvas.findByRole('alert');
  const conflict = within(alert);
  await expect(conflict.getByText(copy.conflictTitle)).toBeVisible();
  const settled = opening.completed ? copy.notWatched : copy.watched;
  await expect(conflict.getAllByText(settled).length).toBeGreaterThan(0);
  await expect(conflict.getByRole('button', { name: copy.keepMine })).toBeVisible();
  await expect(conflict.getByRole('button', { name: copy.useTheirs })).toBeVisible();
  if (parameters.until === 'conflict') {
    alert.scrollIntoView({ block: 'center' });
    await expectNoOverflow(canvasElement);
    return;
  }
  await userEvent.click(conflict.getByRole('button', { name: copy.keepMine }));
  await waitFor(() => expect(secondCanvas.queryByRole('alert')).not.toBeInTheDocument());
  await expectWhere(second, where(after('second')));
  await expectSelected(
    second,
    episodeLabel,
    opening.completed ? 'open' : 'done',
    opening.completed ? copy.notWatched : copy.watched,
  );
  second.scrollIntoView({ block: 'start' });
  await expectNoOverflow(canvasElement);
}

const phone = { viewport: { value: 'phone' as const } };

function recorded(persona: SignedInPersona, direction: AnimeChain, narrow = false): Story {
  return {
    args: { persona, direction },
    play: playDevices,
    ...(narrow ? { globals: phone } : {}),
  };
}

function stopped(persona: SignedInPersona, direction: AnimeChain, narrow = false): Story {
  return { ...recorded(persona, direction, narrow), parameters: { until: 'conflict' } };
}

export const Visitor: Story = { args: { persona: 'visitor' }, play: playVisitor };
export const VisitorPhone: Story = { ...Visitor, globals: phone };

export const StrangerMark = recorded('stranger', 'mark');
export const StrangerMarkPhone = recorded('stranger', 'mark', true);
export const StrangerClear = recorded('stranger', 'clear');
export const StrangerClearPhone = recorded('stranger', 'clear', true);
export const StrangerJapanese: Story = { args: { locale: 'ja', direction: 'mark' }, play: playDevices };
export const StrangerJapanesePhone: Story = { ...StrangerJapanese, globals: phone };
export const StrangerMarkConflict = stopped('stranger', 'mark');
export const StrangerMarkConflictPhone = stopped('stranger', 'mark', true);
export const StrangerClearConflict = stopped('stranger', 'clear');
export const StrangerClearConflictPhone = stopped('stranger', 'clear', true);

export const MemberMark = recorded('member', 'mark');
export const MemberMarkPhone = recorded('member', 'mark', true);
export const MemberClear = recorded('member', 'clear');
export const MemberClearPhone = recorded('member', 'clear', true);

export const OwnerMark = recorded('owner', 'mark');
export const OwnerMarkPhone = recorded('owner', 'mark', true);
export const OwnerClear = recorded('owner', 'clear');
export const OwnerClearPhone = recorded('owner', 'clear', true);

export const ModeratorMark = recorded('moderator', 'mark');
export const ModeratorMarkPhone = recorded('moderator', 'mark', true);
export const ModeratorClear = recorded('moderator', 'clear');
export const ModeratorClearPhone = recorded('moderator', 'clear', true);

export const OperatorMark = recorded('operator', 'mark');
export const OperatorMarkPhone = recorded('operator', 'mark', true);
export const OperatorClear = recorded('operator', 'clear');
export const OperatorClearPhone = recorded('operator', 'clear', true);

export const SecondDeviceLoading: Story = { args: { hold: true, direction: 'mark' }, play: playDevices };
export const SecondDeviceLoadingPhone: Story = { ...SecondDeviceLoading, globals: phone };
