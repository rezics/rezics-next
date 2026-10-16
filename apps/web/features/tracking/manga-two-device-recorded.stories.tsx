import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from './messages.ts';
import {
  mangaActingSubject, mangaSample, type MangaDevicePersona, type MangaDeviceState,
} from './manga-two-device-recorded-page.ts';
import { MangaTwoDeviceRecordedPage } from './manga-two-device-recorded-page.tsx';

const meta = {
  title: 'Tracking/Manga two-device progress recorded',
  component: MangaTwoDeviceRecordedPage,
  args: { persona: 'stranger', locale: 'en', state: 'undo', hold: false },
  globals: { viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof MangaTwoDeviceRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;
type Props = { persona: AnswerPersona; locale?: UiLocale; state?: MangaDeviceState; hold?: boolean };
type PositionAnswer = { scope: string; items: { role: string; occurrence: string; labels: { value: string }[] }[] };

function chapterLabel(persona: AnswerPersona) {
  const selected = mangaSample(persona, 'mark-6').answer as { occurrence: string };
  const positions = mangaSample(persona, 'mark-3').answer as PositionAnswer;
  const item = positions.items.find(item => item.occurrence === selected.occurrence);
  if (!item?.labels[0]?.value) throw new Error('Recorded selected chapter has no label');
  return item.labels[0].value;
}

async function expectWhere(region: HTMLElement, persona: AnswerPersona, label: string, locale: UiLocale) {
  const answer = mangaSample(persona, label).answer as PositionAnswer;
  const t = copyOf(locale);
  const text = answer.scope === 'resume' ? t.lastRead({ place: answer.items[0]!.labels[0]!.value }) : t.unknown;
  await expect(within(region).findByText(text, { exact: true })).resolves.toBeVisible();
}

async function choose(region: HTMLElement, label: string, completed: boolean, locale: UiLocale) {
  const canvas = within(region), t = copyOf(locale);
  await userEvent.click(await canvas.findByRole('button', { name: label }));
  await expectSelected(region, label, completed, locale);
  await expect(canvas.findByRole('button', { name: completed ? t.markChapterUnread : t.markChapterRead })).resolves.toBeEnabled();
}

async function expectSelected(region: HTMLElement, label: string, completed: boolean, locale: UiLocale) {
  const t = copyOf(locale), text = `${label} · ${completed ? t.chapterRead : t.chapterUnread}`;
  await expect(within(region).findByText((_content, element) =>
    element?.tagName === 'P' && element.textContent === text)).resolves.toBeVisible();
}

async function playPage({ canvasElement, args, parameters }: {
  canvasElement: HTMLElement; args: Props; parameters: { until?: 'conflict' };
}) {
  const canvas = within(canvasElement), persona = args.persona, locale = args.locale ?? 'en', t = copyOf(locale);
  const title = (mangaSample(persona, 'frame-1').answer as { title: { value: string } }).title.value;
  const author = (mangaSample(persona, 'frame-2').answer as { items: { displayName: string }[] }).items[0]!.displayName;
  await expect(canvas.findByRole('heading', { name: title, level: 1 })).resolves.toBeVisible();
  await expect(canvas.findByRole('link', { name: author })).resolves.toBeVisible();
  await expect(canvas.findByText(persona[0]!.toUpperCase() + persona.slice(1), { exact: true })).resolves.toBeVisible();
  if (persona === 'visitor') {
    const opening = mangaSample(persona, 'public-contents-1').answer as PositionAnswer;
    for (const item of opening.items.filter(item => item.role === 'chapter')) {
      await expect(canvas.findByRole('link', { name: item.labels[0]!.value })).resolves.toBeVisible();
    }
    await expect(canvas.queryByRole('region', { name: 'First device' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: t.markChapterRead })).not.toBeInTheDocument();
    await expect(mangaActingSubject(persona)).toBeUndefined();
    const chapter = canvas.getByRole('link', { name: opening.items.find(item => item.role === 'chapter')!.labels[0]!.value });
    chapter.scrollIntoView({ block: 'center' });
  } else {
    await expect(canvas.findByText(mangaActingSubject(persona)!, { exact: true })).resolves.toBeVisible();
    const first = await canvas.findByRole('region', { name: 'First device' });
    const label = chapterLabel(persona);
    if (args.state === 'replay') {
      await expectWhere(first, persona, 'mark-2', locale);
      await choose(first, label, false, locale);
      await userEvent.click(within(first).getByRole('button', { name: t.markChapterRead }));
      await expectWhere(first, persona, 'mark-8', locale);
      await expectSelected(first, label, true, locale);
      await expect(within(first).findByRole('button', { name: t.markChapterUnread })).resolves.toBeEnabled();
      first.scrollIntoView({ block: 'start' });
    } else {
      const second = await canvas.findByRole('region', { name: 'Second device · Omnibus' });
      await expectWhere(first, persona, `first-${args.state ?? 'undo'}-2`, locale);
      if (args.hold) {
        await expect(within(second).findByRole('status')).resolves.toHaveTextContent(t.unknown);
        await expect(within(second).getByRole('region', { name: `Second device · Omnibus · ${t.chapters}` })).toHaveAttribute('aria-busy', 'true');
        await expect(within(second).queryByRole('button', { name: label })).not.toBeInTheDocument();
      } else {
        await expectWhere(second, persona, `second-${args.state ?? 'undo'}-2`, locale);
        await choose(first, label, args.state !== 'after-undo', locale);
        await choose(second, label, args.state !== 'after-undo', locale);
        if (args.state !== 'after-undo') {
          await userEvent.click(within(first).getByRole('button', { name: t.markChapterUnread }));
          await expectWhere(first, persona, 'first-undo-7', locale);
          await expectSelected(first, label, false, locale);
          await userEvent.click(within(second).getByRole('button', { name: t.markChapterUnread }));
          await expect(within(second).findByRole('alert')).resolves.toHaveTextContent(t.conflictTitle);
          await expectWhere(second, persona, 'second-undo-8', locale);
          if (parameters.until !== 'conflict') {
            await userEvent.click(within(second).getByRole('button', { name: t.keepMine }));
            await waitFor(() => expect(within(second).queryByRole('alert')).not.toBeInTheDocument());
            await expectWhere(second, persona, 'second-undo-11', locale);
          }
        }
        await expectSelected(second, label, false, locale);
        await expect(within(second).findByRole('button', { name: t.markChapterRead })).resolves.toBeEnabled();
      }
      if (parameters.until === 'conflict') {
        within(second).getByRole('alert').scrollIntoView({ block: 'center' });
      } else if (args.hold) {
        within(second).getByRole('status').scrollIntoView({ block: 'center' });
      } else second.scrollIntoView({ block: 'start' });
    }
  }
  // Unmatched requests are surfaced as an alert by the page instead of silently becoming an empty panel.
  if (parameters.until !== 'conflict') await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

const phone = { viewport: { value: 'phone' } };
function recorded(persona: MangaDevicePersona, state: MangaDeviceState, locale: UiLocale = 'en', narrow = false): Story {
  return { args: { persona, state, locale }, globals: narrow ? phone : meta.globals, play: playPage };
}

export const VisitorPublicOpening: Story = { args: { persona: 'visitor' }, play: playPage };
export const VisitorPublicOpeningPhone: Story = { ...VisitorPublicOpening, globals: phone };

export const StrangerReplay = recorded('stranger', 'replay');
export const StrangerReplayPhone = recorded('stranger', 'replay', 'en', true);
export const StrangerUndoRecovery = recorded('stranger', 'undo');
export const StrangerUndoRecoveryPhone = recorded('stranger', 'undo', 'en', true);
export const StrangerPostUndoFrench = recorded('stranger', 'after-undo', 'fr');
export const StrangerPostUndoFrenchPhone = recorded('stranger', 'after-undo', 'fr', true);

export const MemberReplaySimplifiedChinese = recorded('member', 'replay', 'zh-Hans');
export const MemberReplaySimplifiedChinesePhone = recorded('member', 'replay', 'zh-Hans', true);
export const MemberUndoRecovery = recorded('member', 'undo');
export const MemberUndoRecoveryPhone = recorded('member', 'undo', 'en', true);
export const MemberPostUndoSpanish = recorded('member', 'after-undo', 'es');
export const MemberPostUndoSpanishPhone = recorded('member', 'after-undo', 'es', true);

export const OwnerReplayTraditionalChinese = recorded('owner', 'replay', 'zh-Hant');
export const OwnerReplayTraditionalChinesePhone = recorded('owner', 'replay', 'zh-Hant', true);
export const OwnerUndoRecovery = recorded('owner', 'undo');
export const OwnerUndoRecoveryPhone = recorded('owner', 'undo', 'en', true);
export const OwnerPostUndoGerman = recorded('owner', 'after-undo', 'de');
export const OwnerPostUndoGermanPhone = recorded('owner', 'after-undo', 'de', true);

export const ModeratorReplayJapanese = recorded('moderator', 'replay', 'ja');
export const ModeratorReplayJapanesePhone = recorded('moderator', 'replay', 'ja', true);
export const ModeratorUndoRecovery = recorded('moderator', 'undo');
export const ModeratorUndoRecoveryPhone = recorded('moderator', 'undo', 'en', true);
export const ModeratorPostUndo = recorded('moderator', 'after-undo');
export const ModeratorPostUndoPhone = recorded('moderator', 'after-undo', 'en', true);

export const OperatorReplayKorean = recorded('operator', 'replay', 'ko');
export const OperatorReplayKoreanPhone = recorded('operator', 'replay', 'ko', true);
export const OperatorUndoRecovery = recorded('operator', 'undo');
export const OperatorUndoRecoveryPhone = recorded('operator', 'undo', 'en', true);
export const OperatorPostUndo = recorded('operator', 'after-undo');
export const OperatorPostUndoPhone = recorded('operator', 'after-undo', 'en', true);

export const StaleUndoConflict: Story = { ...recorded('stranger', 'undo'), parameters: { until: 'conflict' } };
export const StaleUndoConflictPhone: Story = { ...StaleUndoConflict, globals: phone };
export const SecondDeviceLoading: Story = { args: { hold: true }, play: playPage };
export const SecondDeviceLoadingPhone: Story = { ...SecondDeviceLoading, globals: phone };
