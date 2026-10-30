import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CopiesPage } from '../library/copies-page';
import { readCopiesPage } from '../library/copies-actions';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Patterns/Library/Copies forms',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const profileSubjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';

function CopiesPattern({ mode, subjectId, retired = false }: { mode: CopiesStoryMode; subjectId?: string; retired?: boolean }) {
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
      <Suspense fallback={null}>
        <div className="w-full max-w-4xl p-4">
          <CopiesPattern mode={mode} {...(subjectId ? { subjectId } : {})} retired={retired} />
        </div>
      </Suspense>
    </PatternStory>
  );
}

async function copiesReady(canvasElement: HTMLElement) {
  await within(canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
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
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_more_actions() }));
    await userEvent.click(within(document.body).getByRole('menuitem', { name: m.library_copy_edit() }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    await dialog.findByRole('form', { name: m.library_copy_edit() });
  },
};

export const CreateRefused: Story = {
  name: 'Create refused',
  tags: ['!dev'],
  render: () => renderCopies('refusal'),
  async play({ canvasElement }) {
    await copiesReady(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_add() }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    await userEvent.type(
      dialog.getByLabelText<HTMLInputElement>(/Edition|版本/),
      '0192f3a0-6c1e-7b2a-9d4e-000000000021',
    );
    await userEvent.click(dialog.getByRole('button', { name: m.library_copy_add_submit() }));
    await expect(dialog.findByRole('alert')).resolves.toBeVisible();
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
