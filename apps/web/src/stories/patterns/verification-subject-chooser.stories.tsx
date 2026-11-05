import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { VerificationSubjectChooserView, type VerificationSubject } from '../../settings/verification-subject-chooser';
import type { VerificationSearchResult } from '../../settings/verification-core';

type Scenario = 'ready' | 'failed' | 'empty' | 'delayed';
const controls = new WeakMap<
  Element,
  {
    finish: () => void;
    disable: () => void;
    calls: string[];
    selections: (VerificationSubject | null)[];
    submits: number;
  }
>();

function Example({ scenario = 'ready' }: { scenario?: Scenario }) {
  const [selected, setSelected] = useState<VerificationSubject | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [fixture] = useState(() => {
    const subjects = [
      { id: 'native-person-id', title: 'Avery', type: m.settings_verification_person() },
      { id: 'native-organization-id', title: 'Avery Studio', type: m.settings_verification_organization() },
    ];
    const state = {
      finish: () => {},
      disable: () => setDisabled(true),
      calls: [] as string[],
      selections: [] as (VerificationSubject | null)[],
      submits: 0,
    };
    const search = async (query: string): Promise<VerificationSearchResult<VerificationSubject[]>> => {
      state.calls.push(query);
      if (scenario === 'failed' && state.calls.length === 1)
        return {
          ok: false,
          failure: {
            kind: 'unavailable',
            status: 0,
            message: m.settings_verification_search_unavailable(),
          },
        };
      if (scenario === 'empty') return { ok: true, value: [] };
      // Intentionally ignores abort to exercise ownership of a late native completion.
      if (scenario === 'delayed')
        return new Promise((resolve) => {
          state.finish = () => resolve({ ok: true, value: subjects });
        });
      return { ok: true, value: subjects };
    };
    return { state, search };
  });
  return (
    <form
      ref={(element) => {
        if (element) controls.set(element, fixture.state);
      }}
      className="mx-auto max-w-2xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        fixture.state.submits++;
      }}
    >
      <VerificationSubjectChooserView
        selected={selected}
        onSelect={(subject) => {
          fixture.state.selections.push(subject);
          setSelected(subject);
        }}
        disabled={disabled}
        search={fixture.search}
      />
    </form>
  );
}

const meta = {
  title: 'Patterns/Account/Verification subject chooser',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The production verification chooser with explicitly illustrative local IO, including dependency failure, real empty and IME composition. Review these same states with phone390 and desktop1280 viewport globals and shared locale/theme globals. Native search and authorization proof remain with integration verification.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const view = (canvasElement: HTMLElement) => within(canvasElement);
const popup = () => within(document.body);
const fixture = (canvasElement: HTMLElement) => controls.get(canvasElement.querySelector('form')!)!;

export const KeyboardJourney: Story = {
  play: async ({ canvasElement }) => {
    const canvas = view(canvasElement);
    const input = canvas.getByRole('combobox', { name: m.settings_verification_subject() });
    await userEvent.type(input, 'Avery');
    await popup().findAllByRole('option');
    await expect(fixture(canvasElement).calls).toEqual(['Avery']);
    await expect(fixture(canvasElement).selections).toEqual([]);
    await expect(input).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup().queryByRole('listbox')).toBeNull());
    await expect(input).toHaveFocus();
    await expect(input).toHaveValue('Avery');
    await userEvent.keyboard('{ArrowDown}');
    await popup().findAllByRole('option');
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    const change = await canvas.findByRole('button', { name: m.settings_verification_change_subject() });
    await expect(fixture(canvasElement).selections.at(-1)?.id).toBe('native-person-id');
    await waitFor(() => expect(change).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    const next = await canvas.findByRole('combobox');
    await waitFor(() => expect(next).toHaveFocus());
    await expect(next).toHaveValue('');
    await userEvent.type(next, 'Studio');
    await popup().findAllByRole('option');
    // A new term invalidates the previously highlighted candidates immediately.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.type(next, ' name');
    await expect(fixture(canvasElement).selections.at(-1)).toBeNull();
    await popup().findAllByRole('option');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await canvas.findByRole('button', { name: m.settings_verification_change_subject() });
    await expect(fixture(canvasElement).selections.at(-1)?.id).toBe('native-organization-id');
    await expect(fixture(canvasElement).submits).toBe(0);
  },
};

export const FailedSearchAndRetry: Story = {
  args: { scenario: 'failed' },
  play: async ({ canvasElement }) => {
    const canvas = view(canvasElement);
    const input = canvas.getByRole('combobox');
    await userEvent.type(input, 'Avery');
    await canvas.findByText(m.settings_verification_search_failed());
    await expect(popup().queryByRole('option')).toBeNull();
    await expect(input).toHaveValue('Avery');
    await userEvent.click(canvas.getByRole('button', { name: m.settings_retry() }));
    await popup().findAllByRole('option');
    await expect(input).toHaveFocus();
    await expect(fixture(canvasElement).calls).toEqual(['Avery', 'Avery']);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await canvas.findByRole('button', { name: m.settings_verification_change_subject() });
    await expect(fixture(canvasElement).submits).toBe(0);
  },
};

export const EmptySearch: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = view(canvasElement);
    await userEvent.type(canvas.getByRole('combobox'), 'Unknown');
    await canvas.findByText(m.settings_verification_search_empty());
    await expect(canvas.queryByRole('button', { name: m.settings_retry() })).toBeNull();
    await expect(popup().queryByRole('option')).toBeNull();
  },
};

export const LoadingAndLateCompletion: Story = {
  args: { scenario: 'delayed' },
  play: async ({ canvasElement }) => {
    const canvas = view(canvasElement);
    const input = canvas.getByRole('combobox');
    await userEvent.type(input, 'Avery');
    await waitFor(() => expect(fixture(canvasElement).calls).toEqual(['Avery']));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.settings_verification_search_loading());
    await userEvent.keyboard('{Escape}{Enter}');
    fixture(canvasElement).finish();
    await canvas.findByText(m.settings_verification_search_results({ count: 2 }));
    await expect(popup().queryByRole('listbox')).toBeNull();
    await expect(fixture(canvasElement).selections).toEqual([]);
    await userEvent.clear(input);
    await userEvent.type(input, 'Studio');
    await waitFor(() => expect(fixture(canvasElement).calls).toHaveLength(2));
    fixture(canvasElement).disable();
    await waitFor(() => expect(input).toBeDisabled());
    fixture(canvasElement).finish();
    await expect(popup().queryByRole('option')).toBeNull();
    await expect(fixture(canvasElement).selections).toEqual([]);
    await expect(fixture(canvasElement).submits).toBe(0);
  },
};

export const CompositionAndCommittedTerm: Story = {
  args: { scenario: 'delayed' },
  play: async ({ canvasElement }) => {
    const canvas = view(canvasElement);
    const input = canvas.getByRole('combobox');
    await userEvent.type(input, 'Avery');
    await waitFor(() => expect(fixture(canvasElement).calls).toEqual(['Avery']));
    const priorCompletion = fixture(canvasElement).finish;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'あ' } });
    // Deliberately keep the IME session open longer than the production debounce.
    await new Promise((resolve) => setTimeout(resolve, 300));
    priorCompletion();
    await expect(fixture(canvasElement).calls).toEqual(['Avery']);
    await expect(popup().queryByRole('option')).toBeNull();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    fireEvent(input, enter);
    await expect(enter.defaultPrevented).toBe(true);
    await expect(fixture(canvasElement).selections).toEqual([]);
    fireEvent.change(input, { target: { value: 'あべ' } });
    fireEvent.compositionEnd(input, { data: 'あべ' });
    await waitFor(() => expect(fixture(canvasElement).calls).toEqual(['Avery', 'あべ']));
    fixture(canvasElement).finish();
    await popup().findAllByRole('option');
    await expect(input).toHaveValue('あべ');
    await userEvent.keyboard('{Enter}');
    await expect(fixture(canvasElement).selections).toEqual([]);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await canvas.findByRole('button', { name: m.settings_verification_change_subject() });
    await expect(fixture(canvasElement).selections.at(-1)?.id).toBe('native-person-id');
    await expect(fixture(canvasElement).submits).toBe(0);
  },
};
