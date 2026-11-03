import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CopiesPage } from '../library/copies-page';
import { readCopiesPage } from '../library/copies-actions';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import recording from '../kernel/recorded/library-copies.json';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory, pagePaths } from './page';

const recordedEdition = recording.copies[0]!.subject.label;

const meta = {
  title: 'Patterns/Library/Copies forms',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Connected CopiesPage forms in AppShell. Source and state mapping stay with Pages/Library/Copies. Plays are authored unrun; native, keyboard and visual proof remain with integration. Review these IDs at phone390 and desktop1280 with locale and theme globals.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const profileSubjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';

function CopiesPattern({
  mode,
  subjectId,
  retired = false,
}: {
  mode: CopiesStoryMode;
  subjectId?: string;
  retired?: boolean;
}) {
  setCopiesStoryMode(mode);
  if (subjectId) setCopyKindsStory(retired);
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'copies-form', mode, subjectId ?? 'all', retired],
    queryFn: () => readCopiesPage({ data: subjectId ? { subjectId } : {} }),
  });
  return <CopiesPage page={data} />;
}

function renderCopies(mode: CopiesStoryMode, subjectId?: string, retired = false) {
  const path = `${pagePaths['library-copies']}${subjectId ? `?subjectId=${subjectId}` : ''}`;
  return (
    <PatternStory visitor="Signed In" path={path}>
      <AppShell>
        <Suspense fallback={null}>
          <CopiesPattern mode={mode} {...(subjectId ? { subjectId } : {})} retired={retired} />
        </Suspense>
      </AppShell>
    </PatternStory>
  );
}

async function copiesReady(canvasElement: HTMLElement) {
  await within(canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
}

async function openCopyActions(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_more_actions() }));
  const view = within(document.body);
  const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
  const actions = await view.findByRole(sheet ? 'dialog' : 'menu', { name: m.library_copy_more_actions() });
  return {
    view,
    actions,
    item: (name: string) => within(actions).getByRole(sheet ? 'button' : 'menuitem', { name }),
  };
}

export const AddFormOpen: Story = {
  name: 'Add form open',
  render: () => renderCopies('one'),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_add() }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    await dialog.findByRole('form', { name: m.library_copy_add() });
  },
};

export const EditFormOpen: Story = {
  name: 'Edit form open',
  render: () => renderCopies('one'),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    const { view, item } = await openCopyActions(canvasElement);
    await userEvent.click(item(m.library_copy_edit()));
    await view.findByRole('dialog');
    await view.findByRole('form', { name: m.library_copy_edit() });
  },
};

export const CreateRefused: Story = {
  name: 'Create refused',
  render: () => renderCopies('refusal'),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_add() }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    const form = await dialog.findByRole('form', { name: m.library_copy_add() });
    await userEvent.type(dialog.getByRole('combobox', { name: m.library_copy_edition() }), 'Prince');
    await userEvent.click(await dialog.findByRole('option', { name: recordedEdition }));
    await userEvent.click(await dialog.findByRole('button', { name: m.library_copy_add_submit() }));
    await expect(dialog.findByRole('alert')).resolves.toBeVisible();
    expect(dialog.getByText(m.library_copy_failure())).toBeVisible();
    expect(form).toBeVisible();
    expect(dialog.getByRole('combobox', { name: m.library_copy_edition() })).toBeVisible();
    expect(dialog.getByText(recordedEdition)).toBeVisible();
  },
};

export const MultipleCopyTypes: Story = {
  name: 'Multiple copy types',
  render: () => renderCopies('one', profileSubjectId),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_add() }));
    await within(document.body).findByRole('combobox', { name: m.library_copy_kind() });
  },
};

export const HistoricalMeaningUnavailable: Story = {
  render: () => renderCopies('one'),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    const canvas = within(canvasElement);
    expect(canvas.getAllByText(m.library_copy_history_notice())).toHaveLength(1);
    const disclosure = canvas.getByText(m.library_copy_history_details());
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    expect(canvas.getByText(m.library_history_unavailable())).not.toBeVisible();
    await userEvent.click(disclosure);
    expect(canvas.getByText(m.library_history_unavailable())).toBeVisible();
  },
};
export const StaleDelete: Story = {
  render: () => renderCopies('stale-delete'),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    const { view, item } = await openCopyActions(canvasElement);
    await userEvent.click(item(m.library_copy_edit()));
    await userEvent.click(await view.findByRole('button', { name: m.library_copy_delete() }));
    await userEvent.click(await view.findByRole('button', { name: m.library_copy_delete_confirm() }));
    await expect(view.findByText(m.library_copy_conflict())).resolves.toBeVisible();
    await expect(
      within(canvasElement).findByRole('button', { name: m.library_copy_more_actions() }),
    ).resolves.toBeVisible();
  },
};
