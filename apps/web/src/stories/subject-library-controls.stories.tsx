import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setFakeAdmitted } from '../kernel/fake';
import { setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { setLibraryLabelStorySizes } from '../kernel/fake/library-label-assignments';
import collections from '../kernel/recorded/library-collections.json';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const admitted = [
  'personal_library',
  'collections',
  'reading_progress',
  'library_label.assignment_list',
  'library_label.list',
  'library_label.create',
  'library_label.assign',
  'library_label.unassign',
];
const meta = {
  title: 'Pages/Subjects/Library Controls',
  id: 'pages-subject-library-controls',
  parameters: {
    layout: 'fullscreen',
    admitted,
    docs: {
      description: {
        component:
          'The ordinary PageStory Subject reader with recorded Collections and existing fake native Label routes. Use the global phone390 and desktop1280 viewports on these same stories. Plays measure real targets, focus and overflow only when rendered in a browser; they are UNRUN at source delivery. Existing Collection recordings have no successful member-create route, so selection retains the actual unavailable outcome. Complete 200-character and unbroken names are covered by the local mounted fixture, not fabricated in recorded stories. Native and full acceptance remain UNRUN.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = { canvasElement: HTMLElement };

function SubjectControlsStory() {
  setFakeAdmitted(admitted);
  setCollectionStoryMode('many');
  setLibraryLabelStorySizes({ subject: 3 });
  return <PageStory visitor="Signed In" path={pagePaths.subject} />;
}

async function controlsReady(context: Context) {
  await pageReady(context);
  const slot = context.canvasElement.querySelector<HTMLElement>('[data-slot="subject-library"]');
  if (!slot) throw new Error('The ordinary Subject reader must contain its Library slot');
  await within(slot).findByRole('button', { name: m.library_subject_label_add() });
  await expect(slot.querySelectorAll('[data-subject-label-chip]')).toHaveLength(3);
  return slot;
}

// Real browser assertions: Happy DOM geometry is deliberately never used as layout evidence.
async function targetsFit(targets: HTMLElement[]) {
  await expect(targets.length).toBeGreaterThan(0);
  const boxes = targets.map((target) => target.getBoundingClientRect());
  for (const box of boxes) {
    await expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(box.width).toBeGreaterThanOrEqual(44);
    await expect(box.left).toBeGreaterThanOrEqual(0);
    await expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  }
  for (let index = 0; index < boxes.length; index++) {
    for (const other of boxes.slice(index + 1)) {
      const box = boxes[index]!;
      const overlapWidth = Math.min(box.right, other.right) - Math.max(box.left, other.left);
      const overlapHeight = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
      await expect(overlapWidth > 0.5 && overlapHeight > 0.5).toBe(false);
    }
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}

async function keyboardReach(target: HTMLElement) {
  // Reach the real target through the browser's tab order, including the chooser's focus trap.
  for (let attempt = 0; attempt < 120; attempt++) {
    await userEvent.tab();
    if (document.activeElement === target) break;
  }
  await expect(target).toHaveFocus();
  await expect(target.matches(':focus-visible')).toBe(true);
  const style = getComputedStyle(target);
  await expect(style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2).toBe(true);
}

function shelfTargets(slot: HTMLElement) {
  return [...slot.querySelectorAll<HTMLElement>('[data-subject-label-chip] a, [data-subject-label-remove] button')];
}

function picker(slot: HTMLElement) {
  const form = slot.querySelector<HTMLElement>('[data-subject-label-picker]');
  if (!form) throw new Error('The actual Label picker must be open');
  return form;
}

async function openPicker(slot: HTMLElement) {
  const trigger = slot.querySelector<HTMLElement>('[data-subject-label-picker-details] summary');
  if (!trigger) throw new Error('The actual Label picker trigger is missing');
  await targetsFit([...shelfTargets(slot), trigger]);
  await keyboardReach(trigger);
  await userEvent.click(trigger);
  return within(picker(slot)).findByRole('textbox', { name: m.library_subject_label_name() });
}

export const LoadedCollectionChoices: Story = {
  name: 'Loaded Collection choices',
  render: () => <SubjectControlsStory />,
  play: async (context) => {
    const slot = await controlsReady(context);
    await userEvent.click(within(slot).getByRole('button', { name: m.library_subject_add_collection() }));
    const body = within(document.body);
    const load = await body.findByRole('button', { name: m.library_subject_load_collections() });
    const chooser = within(load.closest('form')!.parentElement!);
    await targetsFit([load]);
    await keyboardReach(load);
    await userEvent.keyboard('{Enter}');
    const choices = await Promise.all(
      collections.collections.map(async (row) => {
        const title = await chooser.findByText(row.title, { exact: true });
        const button = title.closest('button');
        if (!button) throw new Error('Collection selection must remain an actual button');
        return button;
      }),
    );
    await targetsFit(choices);
    await expect(choices.map((button) => button.textContent)).toEqual(
      collections.collections.map((row) => row.title + row.memberCount),
    );
    await expect(choices[0]!.closest('ul')!.querySelectorAll('button')).toHaveLength(choices.length);
    await keyboardReach(choices[1]!);
    await userEvent.keyboard('{Enter}');
    // No synthetic success: the existing fake transport has no member-create success recording.
    await within(slot).findByText(m.library_subject_unavailable());
    await targetsFit(choices);
  },
};

export const LabelPickerAndAssignment: Story = {
  name: 'Label picker and assignment',
  render: () => <SubjectControlsStory />,
  play: async (context) => {
    const slot = await controlsReady(context);
    const input = await openPicker(slot);
    await userEvent.type(input, 'Empty');
    const existing = await within(picker(slot)).findByRole('button', { name: 'Empty label' });
    const cancel = within(picker(slot)).getByRole('button', { name: m.library_collection_cancel() });
    const submit = picker(slot).querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await targetsFit([input, existing, cancel, submit]);
    await keyboardReach(existing);
    await userEvent.keyboard('{Enter}');
    await within(slot).findByRole('link', { name: 'Empty label' });
    await targetsFit(shelfTargets(slot));
    const nextInput = await openPicker(slot);
    await userEvent.type(nextInput, 'Family reading');
    const create = await within(picker(slot)).findByRole('button', {
      name: m.library_subject_label_create({ name: 'Family reading' }),
    });
    await targetsFit([nextInput, create]);
    await keyboardReach(create);
    await userEvent.keyboard('{Enter}');
    await within(slot).findByRole('link', { name: 'Family reading' });
    await targetsFit(shelfTargets(slot));
    await openPicker(slot);
    const close = within(picker(slot)).getByRole('button', { name: m.library_collection_cancel() });
    await keyboardReach(close);
    await userEvent.keyboard('{Enter}');
    await expect(slot.querySelector('[data-subject-label-picker]')).toBeNull();
    await expect(slot.querySelector('[data-subject-label-picker-details] summary')).toHaveFocus();
    // Leave the real picker open for the connected visual review.
    const finalInput = await openPicker(slot);
    await userEvent.type(finalInput, 'Empty');
    const finalChoice = await within(picker(slot)).findByRole('button', { name: 'Empty label' });
    await targetsFit([finalInput, finalChoice, ...shelfTargets(slot)]);
  },
};

export const LabelRemoveAndUndo: Story = {
  name: 'Label remove and Undo',
  render: () => <SubjectControlsStory />,
  play: async (context) => {
    const slot = await controlsReady(context);
    const shelf = await within(slot).findByRole('link', { name: 'Reading list' });
    const remove = within(slot).getByRole('button', { name: m.library_subject_label_remove({ name: 'Reading list' }) });
    await expect(shelf.contains(remove)).toBe(false);
    await expect(remove.closest('form')).toHaveAttribute('method', 'post');
    await targetsFit(shelfTargets(slot));
    await keyboardReach(shelf);
    await userEvent.tab();
    await expect(remove).toHaveFocus();
    await expect(remove.matches(':focus-visible')).toBe(true);
    await userEvent.keyboard('{Enter}');
    const undoForm = slot.querySelector<HTMLElement>('[data-label-undo]');
    if (!undoForm) {
      await within(slot).findByRole('button', { name: m.library_subject_label_undo() });
    }
    const inlineUndo = slot.querySelector<HTMLButtonElement>('[data-label-undo] button')!;
    await expect(within(slot).queryByRole('link', { name: 'Reading list' })).toBeNull();
    await targetsFit([inlineUndo, ...shelfTargets(slot)]);
    await keyboardReach(inlineUndo);
    await userEvent.keyboard('{Enter}');
    await within(slot).findByRole('link', { name: 'Reading list' });
    await expect(slot.querySelector('[data-label-undo]')).toBeNull();
    await targetsFit(shelfTargets(slot));
    // Retain an actual Undo state for phone/desktop visual inspection after exercising restore.
    await userEvent.click(
      within(slot).getByRole('button', { name: m.library_subject_label_remove({ name: 'Favorites' }) }),
    );
    await within(slot).findByRole('button', { name: m.library_subject_label_undo() });
    const finalUndo = slot.querySelector<HTMLButtonElement>('[data-label-undo] button')!;
    await targetsFit([finalUndo, ...shelfTargets(slot)]);
    await keyboardReach(finalUndo);
  },
};
