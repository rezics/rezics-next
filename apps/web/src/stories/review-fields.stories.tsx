import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import boardRecording from '../kernel/recorded/board.json';
import searchRecording from '../kernel/recorded/search.json';
import subjectRecording from '../kernel/recorded/subject.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import { ReviewFields, type CurrentReviewVote } from '../threads/review-fields';
import {
  observeThreadCreationReader,
  ThreadCreationLifetimeProvider,
  useThreadCreationLifetime,
  type ThreadCreationReaderAdmission,
} from '../threads/thread-creation-lifetime';
import { PatternStory } from './page';

// Illustrative only: existing Storybook session/request and recorded vote fixtures, never native proof.
// All plays, physical target/focus checks and 390/1280 locale/theme observations are authored UNRUN.
const meta = {
  title: 'Subjects/Review Fields',
  id: 'patterns-review-fields',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative actual ReviewFields in two independent visits, using the existing signed-in story session and recorded reads. Native acceptance remains UNRUN.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const longTitle = `Übersetzungen・翻訳・ترجمات ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8)}`;
type ExampleProps = { rtl?: boolean; empty?: boolean; noVote?: boolean };

function ReviewVisit({
  index,
  admission,
  disabled,
  empty,
  noVote,
}: ExampleProps & { index: number; admission: ThreadCreationReaderAdmission; disabled: boolean }) {
  const visit = useThreadCreationLifetime(
    { boardId: boardRecording.board.id, purpose: 'reviews', initialKey: `illustrative-review-${index}` },
    admission,
  );
  const [, setSubject] = useState<string | null>(null);
  const [citation, setCitation] = useState<CurrentReviewVote>();
  const title = index === 0 ? subjectRecording.subject.labels[getLocale()] : longTitle;
  return (
    <ThreadCreationLifetimeProvider lifetime={visit.lifetime}>
      <form aria-label={`Illustrative review ${index + 1}`} className="min-w-0 space-y-3">
        {visit.bound ? (
          <ReviewFields
            {...(empty
              ? {}
              : {
                  initialSubjectId: noVote ? searchRecording.subjects[0]!.id : subjectRecording.subject.id,
                  initialSubjectTitle: noVote ? searchRecording.subjects[0]!.labels.en : title,
                })}
            searchScope={visit.scopeKey}
            disabled={disabled}
            onSubjectChange={setSubject}
            onVoteCitationChange={setCitation}
          />
        ) : (
          <p>Original illustrative visit retired.</p>
        )}
        <output aria-label={`Illustrative citation ${index + 1}`} className="block text-sm">
          {citation ? `${citation.units / 2} / 10` : 'No citation selected'}
        </output>
      </form>
    </ThreadCreationLifetimeProvider>
  );
}

function AdmittedExamples({
  admission: initialAdmission,
  ...props
}: ExampleProps & {
  admission: ThreadCreationReaderAdmission;
}) {
  const [admission] = useState(initialAdmission);
  const [disabled, setDisabled] = useState(false);
  const client = useQueryClient();
  return (
    <main dir={props.rtl ? 'rtl' : 'ltr'} className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6 p-4">
      <p role="note" className="text-sm text-muted-foreground">
        Illustrative forms using existing story fixtures. Native acceptance is UNRUN.
      </p>
      <div className="flex flex-wrap gap-4">
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 focus-visible:outline-2"
          onClick={() => setDisabled(!disabled)}
        >
          {disabled ? 'Unlock illustrative fields' : 'Lock illustrative fields'}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 focus-visible:outline-2"
          onClick={() => void client.fetchQuery({ ...sessionQuery, staleTime: 0 })}
        >
          Refresh session to retire original visits
        </button>
      </div>
      <div className="grid min-w-0 gap-6 md:grid-cols-2">
        <ReviewVisit index={0} admission={admission} disabled={disabled} {...props} />
        <ReviewVisit index={1} admission={admission} disabled={disabled} {...props} />
      </div>
    </main>
  );
}

function AuthenticatedExamples(props: ExampleProps) {
  const client = useQueryClient();
  const session = useQuery(sessionQuery);
  const observation = observeThreadCreationReader(client);
  if (!observation || !session.data?.subject) return <p>Loading existing illustrative session…</p>;
  return <AdmittedExamples admission={{ observation, actualSubject: session.data.subject }} {...props} />;
}

function Examples(props: ExampleProps) {
  return (
    <PatternStory visitor="Signed In">
      <AuthenticatedExamples {...props} />
    </PatternStory>
  );
}

async function controls(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const checkboxes = await canvas.findAllByRole('checkbox');
  await expect(checkboxes).toHaveLength(2);
  return { canvas, checkboxes };
}

export const IndependentForms: Story = {
  render: () => <Examples />,
  play: async ({ canvasElement }) => {
    const { canvas, checkboxes } = await controls(canvasElement);
    await expect(checkboxes[0]!.id).not.toBe(checkboxes[1]!.id);
    const forms = canvas.getAllByRole('form');
    const native = forms.map((form) => form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await expect(native[0]!.id).not.toBe(native[1]!.id);
    for (const [index, form] of forms.entries()) {
      const label = form.querySelector<HTMLLabelElement>('label[for]')!;
      await expect(label.htmlFor).toBe(native[index]!.id);
      await expect(label.control).toBe(native[index]);
      await expect(checkboxes[index]!).toHaveAttribute('aria-labelledby', label.id);
      await userEvent.click(label.lastElementChild!);
      await expect(checkboxes[index]!).toBeChecked();
      await expect(canvas.getByLabelText(`Illustrative citation ${index + 1}`)).toHaveTextContent('8 / 10');
      if (index === 0) await expect(checkboxes[1]!).not.toBeChecked();
    }
    await expect(canvas.getAllByRole('combobox', { name: m.thread_review_subject() })).toHaveLength(2);
  },
};

export const KeyboardAndDisabled: Story = {
  render: () => <Examples />,
  play: async ({ canvasElement }) => {
    const { canvas, checkboxes } = await controls(canvasElement);
    canvas.getAllByRole('combobox')[0]!.focus();
    await userEvent.tab();
    await expect(checkboxes[0]!).toHaveFocus();
    await userEvent.keyboard('[Space]');
    await expect(checkboxes[0]!).toBeChecked();
    await expect(checkboxes[1]!).not.toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Lock illustrative fields' }));
    for (const control of checkboxes) await expect(control).toHaveAttribute('aria-disabled', 'true');
    for (const control of canvas.getAllByRole('combobox')) await expect(control).toBeDisabled();
    await userEvent.click(canvas.getAllByRole('form')[1]!.querySelector('label')!.lastElementChild!);
    await expect(checkboxes[1]!).not.toBeChecked();
    await expect(canvas.getByLabelText('Illustrative citation 1')).toHaveTextContent('8 / 10');
  },
};

export const LongTextRtl: Story = {
  render: () => <Examples rtl />,
  play: async ({ canvasElement }) => {
    const { checkboxes } = await controls(canvasElement);
    for (const control of checkboxes) {
      const label = control.closest('label')!;
      await expect(label.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      const help = canvasElement.ownerDocument.getElementById(control.getAttribute('aria-describedby')!)!;
      await expect(help).toHaveTextContent(m.thread_review_details_citation_help());
      await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
      await expect(help.scrollWidth).toBeLessThanOrEqual(help.clientWidth);
    }
    const selected = canvasElement.querySelectorAll<HTMLElement>('[data-slot="review-selected-subject"]');
    await expect(selected[1]!).toHaveTextContent(longTitle);
    for (const text of selected) await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
    const main = within(canvasElement).getByRole('main');
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    checkboxes[0]!.focus();
    await expect(checkboxes[0]!).toHaveFocus();
    await expect(getComputedStyle(checkboxes[0]!.closest('label')!).outlineStyle).not.toBe('none');
  },
};

export const NoCurrentVote: Story = {
  render: () => <Examples noVote />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole('combobox');
    await expect(canvas.queryAllByRole('checkbox')).toHaveLength(0);
    await expect(canvasElement.querySelector('[data-slot="field-description"]')).toBeNull();
  },
};

export const NoSelectedSubject: Story = {
  render: () => <Examples empty />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole('combobox');
    await expect(canvas.queryAllByRole('checkbox')).toHaveLength(0);
    await expect(canvasElement.querySelector('[data-slot="review-selected-subject"]')).toBeNull();
  },
};

export const RetiredVisits: Story = {
  render: () => <Examples />,
  play: async ({ canvasElement }) => {
    const { canvas } = await controls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh session to retire original visits' }));
    await waitFor(() => expect(canvas.queryAllByRole('combobox')).toHaveLength(0));
    await expect(canvas.queryAllByRole('checkbox')).toHaveLength(0);
    await expect(canvasElement.querySelector('[data-slot="review-selected-subject"]')).toBeNull();
  },
};
