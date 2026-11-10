import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { SetupBoardPicker } from '../community/setup-board-picker-control';
import {
  BoardChoiceError,
  type BoardChoiceFailure,
  type BoardChoiceRead,
  type BoardChoiceSource,
} from '../community/setup-board-picker';
import type { SetupChoice } from '../community/space-setup';
import { m } from '../paraglide/messages.js';

const schemeId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const otherSchemeId = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const supplied = [
  { id: '0192f3a0-6c1e-7b2a-9d4e-000000000004', label: 'Introductions' },
  { id: '0192f3a0-6c1e-7b2a-9d4e-000000000006', label: 'Reading together' },
];
const longLabel = `Supplied multilingual label — 閱讀の話題 — موضوعات القراءة — ${'UnbrokenSuppliedLabel'.repeat(18)}`;
const cursor = 'opaque:/sparse+window?token=%2F==';
type Mode = 'ready' | 'empty' | 'sparse' | 'updating' | 'loading' | BoardChoiceFailure;

function BoardChoiceExample({
  kind = 'concept',
  mode = 'ready',
  long = false,
  selected = false,
  disabled = false,
  direction = 'ltr',
  replaceable = false,
  onChange,
  onRead,
}: {
  kind?: 'scheme' | 'concept';
  mode?: Mode;
  long?: boolean;
  selected?: boolean;
  disabled?: boolean;
  direction?: 'ltr' | 'rtl';
  replaceable?: boolean;
  onChange(value: SetupChoice | null): void;
  onRead(input: BoardChoiceRead): void;
}) {
  const [value, setValue] = useState<SetupChoice | null>(
    selected ? { ...supplied[0]!, label: long ? longLabel : supplied[0]!.label } : null,
  );
  const [sourceRevision, setSourceRevision] = useState(0);
  const [scheme, setScheme] = useState(schemeId);
  const source = useMemo<BoardChoiceSource>(() => {
    // Supplied display contracts only: no catalogue, membership or command admission is inferred.
    const choices = supplied.map((choice, index) => ({
      ...choice,
      label: sourceRevision
        ? `Replacement supplied choice ${index + 1}`
        : long
          ? `${longLabel} ${index + 1}`
          : choice.label,
    }));
    async function read(input: BoardChoiceRead) {
      onRead(input);
      if (mode === 'loading') return new Promise<never>(() => {});
      if (mode === 'denied' || mode === 'stale' || mode === 'invalid' || mode === 'unavailable')
        throw new BoardChoiceError(
          mode,
          mode === 'denied' ? 403 : mode === 'stale' ? 410 : mode === 'invalid' ? 400 : 503,
        );
      return {
        choices:
          mode === 'empty' || (mode === 'sparse' && input.cursor === undefined)
            ? []
            : input.kind === 'scheme'
              ? choices.filter((choice) => choice.label.toLowerCase().includes(input.query.toLowerCase()))
              : choices,
        next: mode === 'sparse' && input.cursor === undefined ? cursor : null,
        ...(mode === 'updating'
          ? { freshness: { consistency: 'eventual', target_seconds: 10, caught_up: false } as const }
          : {}),
      };
    }
    return {
      conceptQuery: 'loaded-page',
      async schemes(input) {
        const { choices, next } = await read({ ...input, kind: 'scheme' });
        return { schemes: choices, next };
      },
      async concepts(input) {
        const { choices, ...observation } = await read({ ...input, kind: 'concept' });
        return { concepts: choices, ...observation };
      },
    };
  }, [mode, long, sourceRevision, onRead]);
  return (
    <div dir={direction} className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 p-6 text-foreground">
      {replaceable ? (
        <div className="flex flex-wrap gap-3">
          <Button className="h-auto min-h-11 whitespace-normal" onClick={() => setSourceRevision((value) => value + 1)}>
            Replace display source
          </Button>
          <Button
            className="h-auto min-h-11 whitespace-normal"
            onClick={() => setScheme((value) => (value === schemeId ? otherSchemeId : schemeId))}
          >
            Change supplied scheme
          </Button>
        </div>
      ) : null}
      <SetupBoardPicker
        kind={kind}
        schemeId={scheme}
        source={source}
        value={value}
        disabled={disabled}
        onChange={(choice) => {
          setValue(choice);
          onChange(choice);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Community/Space Setup/Board Choice Interface',
  id: 'patterns-community-space-setup-board-choice-interface',
  component: BoardChoiceExample,
  args: { onChange: fn(), onRead: fn() },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual setup picker with bounded BoardChoiceSource display fixtures. All play observations are authored UNRUN. Review these IDs at phone390/desktop1280, all locale and theme globals, and RTL. Native authorization, full acceptance and physical/browser review remain owed.',
      },
    },
  },
} satisfies Meta<typeof BoardChoiceExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SchemeSelection: Story = {
  args: { kind: 'scheme' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('radio', { name: supplied[1]!.label }));
    await expect(args.onChange).toHaveBeenLastCalledWith(supplied[1]);
    await expect(view.getByRole('searchbox')).toHaveAccessibleDescription(m.space_setup_board_scheme_choices_hint());
  },
};
export const ConceptSelection: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('radio', { name: supplied[0]!.label }));
    await expect(args.onChange).toHaveBeenLastCalledWith(supplied[0]);
    await expect(view.getByRole('searchbox')).toHaveAccessibleDescription(
      `${m.space_setup_concept_hint()} ${m.space_setup_board_choice_local_hint()}`,
    );
  },
};

async function observeGeometry(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await view.findAllByRole('radio');
  const targets = [
    view.getByRole('searchbox'),
    ...view.queryAllByRole('button'),
    ...view.getAllByRole('radio').map((radio) => radio.closest('label')!),
  ];
  for (const target of targets) {
    const rect = target.getBoundingClientRect();
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  }
  const suppliedText = view.getAllByRole('radio').map((radio) => radio.closest('label')!.lastElementChild!);
  suppliedText.push(view.getByText(longLabel, { exact: true }));
  for (const label of suppliedText) {
    await expect(label.textContent).toContain(longLabel);
    await expect(getComputedStyle(label).overflowWrap).toBe('anywhere');
    await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
  }
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  await expect(canvasElement.querySelector('details')).toBeNull();
}
export const LongSuppliedLabelsPhone: Story = {
  args: { long: true, selected: true },
  globals: {},
  play: async ({ canvasElement }) => observeGeometry(canvasElement),
};
export const LongSuppliedLabelsDesktop: Story = {
  ...LongSuppliedLabelsPhone,
  globals: {},
};
export const LongSuppliedLabelsRtl: Story = {
  ...LongSuppliedLabelsPhone,
  args: { long: true, selected: true, direction: 'rtl' },
};
export const LongSuppliedLabelsRtlDesktop: Story = {
  ...LongSuppliedLabelsRtl,
  globals: {},
};
export const LongSchemeLabelsPhone: Story = {
  ...LongSuppliedLabelsPhone,
  args: { kind: 'scheme', long: true, selected: true },
};
export const LongSchemeLabelsDesktop: Story = {
  ...LongSchemeLabelsPhone,
  globals: {},
};
export const LongSchemeLabelsRtl: Story = {
  ...LongSuppliedLabelsRtl,
  args: { kind: 'scheme', long: true, selected: true, direction: 'rtl' },
};
export const LongSchemeLabelsRtlDesktop: Story = {
  ...LongSchemeLabelsRtl,
  globals: {},
};
export const SuccessfulEmpty: Story = {
  args: { kind: 'scheme', mode: 'empty' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.space_setup_board_choice_no_matches())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.space_setup_retry() })).toBeNull();
  },
};
export const LoadedPageNoLocalMatch: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await view.findAllByRole('radio');
    await userEvent.type(view.getByRole('searchbox'), 'not in this loaded page');
    await expect(await view.findByText(m.space_setup_board_choice_local_empty())).toBeVisible();
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await userEvent.clear(view.getByRole('searchbox'));
    await expect(await view.findByRole('radio', { name: supplied[0]!.label })).toBeVisible();
  },
};
export const SparseNext: Story = {
  args: { mode: 'sparse' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const next = await view.findByRole('button', { name: m.space_setup_board_choice_next() });
    await expect(view.getByText(m.space_setup_board_choice_local_empty())).toBeVisible();
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await expect(next.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(next.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await userEvent.click(next);
    await expect(await view.findByRole('radio', { name: supplied[0]!.label })).toBeVisible();
    await expect(args.onRead).toHaveBeenLastCalledWith({ kind: 'concept', schemeId, query: '', cursor });
  },
};
export const Updating: Story = {
  args: { mode: 'updating' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.space_setup_board_choice_updating())).toBeVisible();
    await expect(view.getAllByRole('radio')).toHaveLength(2);
  },
};
export const Loading: Story = { args: { mode: 'loading', selected: true } };

async function observeRefusal(canvasElement: HTMLElement, text: string) {
  const view = within(canvasElement);
  await expect(await view.findByText(text)).toBeVisible();
  await expect(view.queryByText(m.space_setup_board_choice_no_matches())).toBeNull();
  await expect(view.queryByText(m.space_setup_board_choice_local_empty())).toBeNull();
  const retry = view.getByRole('button', { name: m.space_setup_retry() });
  await expect(retry.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await expect(retry.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
}
export const Denied: Story = {
  args: { mode: 'denied' },
  play: async ({ canvasElement }) => observeRefusal(canvasElement, m.space_setup_denied()),
};
export const Stale: Story = {
  args: { mode: 'stale' },
  play: async ({ canvasElement, args }) => {
    await observeRefusal(canvasElement, m.space_setup_board_choice_stale());
    await expect(args.onRead).toHaveBeenCalledTimes(1);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.space_setup_retry() }));
    await expect(await within(canvasElement).findByText(m.space_setup_board_choice_stale())).toBeVisible();
    await expect(args.onRead).toHaveBeenLastCalledWith({ kind: 'concept', schemeId, query: '' });
  },
};
export const Invalid: Story = {
  args: { mode: 'invalid' },
  play: async ({ canvasElement }) => observeRefusal(canvasElement, m.space_setup_invalid()),
};
export const Unavailable: Story = {
  args: { mode: 'unavailable' },
  play: async ({ canvasElement }) => observeRefusal(canvasElement, m.space_setup_board_choice_unavailable()),
};
export const SelectedClear: Story = {
  args: { selected: true },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.space_setup_board_choice_clear() }));
    await expect(args.onChange).toHaveBeenLastCalledWith(null);
  },
};
export const Disabled: Story = {
  args: { selected: true, disabled: true },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('searchbox')).toBeDisabled();
    await expect(view.getByRole('button', { name: m.space_setup_board_choice_clear() })).toBeDisabled();
    await expect(args.onRead).not.toHaveBeenCalled();
    await expect(args.onChange).not.toHaveBeenCalled();
  },
};
export const ChangedScope: Story = {
  args: { replaceable: true },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const retired = await view.findByRole('radio', { name: supplied[0]!.label });
    await userEvent.click(view.getByRole('button', { name: 'Replace display source' }));
    await view.findByRole('radio', { name: 'Replacement supplied choice 1' });
    retired.click();
    await expect(args.onChange).not.toHaveBeenCalled();
    await userEvent.click(view.getByRole('button', { name: 'Change supplied scheme' }));
    await view.findByRole('radio', { name: 'Replacement supplied choice 1' });
    await expect(args.onRead).toHaveBeenLastCalledWith({ kind: 'concept', schemeId: otherSchemeId, query: '' });
    await userEvent.type(view.getByRole('searchbox'), 'absent');
    await expect(await view.findByText(m.space_setup_board_choice_local_empty())).toBeVisible();
    await expect(args.onRead).toHaveBeenCalledTimes(3);
  },
};
export const KeyboardAndFocus: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const radios = await view.findAllByRole('radio');
    view.getByRole('searchbox').focus();
    await userEvent.tab();
    await expect(radios[0]).toHaveFocus();
    const style = getComputedStyle(radios[0]!.closest('label')!);
    await expect(style.outlineStyle).not.toBe('none');
    await expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
    await userEvent.keyboard('{ArrowDown}');
    await expect(args.onChange).toHaveBeenLastCalledWith(supplied[1]);
    await expect(radios[1]).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(view.getByRole('searchbox')).toHaveFocus();
    await expect(getComputedStyle(view.getByRole('searchbox')).outlineStyle).toBe('solid');
    await userEvent.tab({ shift: true });
    const clear = view.getByRole('button', { name: m.space_setup_board_choice_clear() });
    await expect(clear).toHaveFocus();
    await expect(getComputedStyle(clear).outlineStyle).toBe('solid');
    await userEvent.keyboard(' ');
    await expect(args.onChange).toHaveBeenLastCalledWith(null);
  },
};
