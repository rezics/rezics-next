import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from './messages.ts';
import { AnimeTwoDeviceRecordedPage } from './anime-two-device-recorded-page.tsx';
import { recordedSample } from './anime-two-device-recorded-page.ts';

interface Props {
  persona: AnswerPersona;
  locale?: UiLocale;
  hold?: boolean;
}

const meta = {
  title: 'Tracking/Anime two-device progress recorded',
  component: AnimeTwoDeviceRecordedPage,
  args: { persona: 'stranger', locale: 'en', hold: false },
  globals: { viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof AnimeTwoDeviceRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

interface ResumeAnswer {
  items?: { displayLabel?: string }[];
}
interface StructureAnswer {
  occurrences: { qualifier?: { displayLabel?: string } }[];
}
interface ProgressAnswer {
  completed: boolean;
}

function labelAt(persona: AnswerPersona, index: number): string {
  const label = (recordedSample(persona, 'episode-structure').answer as StructureAnswer)
    .occurrences[index]?.qualifier?.displayLabel;
  if (!label) throw new Error(`Recorded episode ${index} has no display label`);
  return label;
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
  await waitFor(() => {
    const selected = region.querySelector('[data-selected]');
    expect(selected).toHaveTextContent(label);
    expect(selected?.querySelector(`[data-state="${state}"]`)).toHaveTextContent(text);
  });
}

async function expectNoOverflow(canvasElement: HTMLElement) {
  await document.fonts.ready;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

async function playVisitor({ canvasElement, args }: { canvasElement: HTMLElement; args: Props }) {
  const canvas = within(canvasElement);
  const title = (recordedSample('visitor', 'work-header').answer as { title: { value: string } })
    .title.value;
  const author = (
    recordedSample('visitor', 'agent-credits').answer as { items: { displayName: string }[] }
  ).items[0]!.displayName;
  await expect(canvas.findByRole('heading', { level: 1, name: title })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: author })).resolves.toBeVisible();
  await expect(canvas.findByText('Visitor')).resolves.toBeVisible();
  await expect(canvas.queryByRole('heading', { name: 'Episodes' })).not.toBeInTheDocument();
  await expect(canvas.queryByText('First device')).not.toBeInTheDocument();
  await expectNoOverflow(canvasElement);
  expect(args.persona).toBe('visitor');
}

async function playDevices({ canvasElement, args }: { canvasElement: HTMLElement; args: Props }) {
  const canvas = within(canvasElement);
  const locale = args.locale ?? 'en';
  const copy = copyOf(locale);
  const persona = args.persona;
  if (persona === 'visitor') return playVisitor({ canvasElement, args });
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
  const personaLabel = persona[0]!.toUpperCase() + persona.slice(1);
  await expect(canvas.findByText(personaLabel)).resolves.toBeVisible();

  const first = await canvas.findByRole('region', { name: 'First device' });
  const firstCanvas = within(first);
  await firstCanvas.findByRole('textbox', { name: copy.jumpTo });
  await expect(firstCanvas.getByText(copy.unknown)).toBeVisible();
  const later = recordedSample(persona, 'first-device-next-version').answer as ProgressAnswer;
  await jump(first, locale, '1');
  await expectSelected(
    first,
    labelAt(persona, 0),
    later.completed ? 'done' : 'open',
    later.completed ? copy.watched : copy.notWatched,
  );

  const second = await canvas.findByRole('region', { name: 'Second device' });
  const secondCanvas = within(second);
  if (args.hold) {
    await expect(
      secondCanvas.findByRole('heading', { name: copy.episodes }),
    ).resolves.toBeVisible();
    await expect(second).toHaveAttribute('data-pending');
    expect(secondCanvas.queryByRole('textbox', { name: copy.jumpTo })).not.toBeInTheDocument();
    await expectNoOverflow(canvasElement);
    return;
  }
  const place = (recordedSample(persona, 'second-device-resume').answer as ResumeAnswer).items?.[0]
    ?.displayLabel;
  if (!place) throw new Error('Recorded resume has no display label');
  await expect(secondCanvas.findByText(copy.lastWatched({ place }))).resolves.toBeVisible();
  await jump(second, locale, '1');
  await expectSelected(second, labelAt(persona, 0), 'done', copy.watched);
  await userEvent.click(secondCanvas.getByRole('button', { name: copy.markNotWatched }));
  const race = recordedSample(persona, 'first-device-race');
  if (race.status === 200)
    await expectSelected(second, labelAt(persona, 0), 'open', copy.notWatched);
  else {
    await expect(secondCanvas.findByText(copy.saveFailed)).resolves.toBeVisible();
    await expectSelected(second, labelAt(persona, 0), 'done', copy.watched);
  }
  await jump(second, locale, '3');
  await expectSelected(second, labelAt(persona, 2), 'open', copy.notWatched);
  await expectNoOverflow(canvasElement);
}

export const Visitor: Story = { args: { persona: 'visitor' }, play: playVisitor };
export const VisitorPhone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };

export const Stranger: Story = { play: playDevices };
export const StrangerPhone: Story = { ...Stranger, globals: { viewport: { value: 'phone' } } };
export const StrangerJapanese: Story = { args: { locale: 'ja' }, play: playDevices };
export const StrangerJapanesePhone: Story = {
  ...StrangerJapanese,
  globals: { viewport: { value: 'phone' } },
};

export const Member: Story = { args: { persona: 'member' }, play: playDevices };
export const MemberPhone: Story = { ...Member, globals: { viewport: { value: 'phone' } } };

export const Owner: Story = { args: { persona: 'owner' }, play: playDevices };
export const OwnerPhone: Story = { ...Owner, globals: { viewport: { value: 'phone' } } };

export const Moderator: Story = { args: { persona: 'moderator' }, play: playDevices };
export const ModeratorPhone: Story = { ...Moderator, globals: { viewport: { value: 'phone' } } };

export const Operator: Story = { args: { persona: 'operator' }, play: playDevices };
export const OperatorPhone: Story = { ...Operator, globals: { viewport: { value: 'phone' } } };

export const SecondDeviceLoading: Story = { args: { hold: true }, play: playDevices };
export const SecondDeviceLoadingPhone: Story = {
  ...SecondDeviceLoading,
  globals: { viewport: { value: 'phone' } },
};
