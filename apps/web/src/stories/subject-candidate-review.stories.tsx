import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import { CandidateStory } from '../subject/candidate-story';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import definitions from '../kernel/recorded/definitions-release.json';
import { candidateProperty } from '../kernel/fake/subject-candidates';
import { pickText } from '@rezics/composition';
import { pagePaths, PatternStory } from './page';
import { selectSharedOption } from './shared-select-interaction';

const meta = {
  title: 'Catalogue/Subject Candidate Review',
  id: 'patterns-subject-candidate-review',
  component: CandidateStory,
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <Story />
      </PatternStory>
    ),
  ],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CandidateStory>;
export default meta;
type Story = StoryObj<typeof meta>;

type CandidateProperty = keyof typeof definitions.release.properties;

function candidateFieldLabel(property: CandidateProperty) {
  return pickText(definitions.release.properties[property].labels, getLocale()).text;
}

async function candidates(canvasElement: HTMLElement, property: CandidateProperty = candidateProperty) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_entry() }));
  await selectSharedOption(
    await canvas.findByRole('combobox', { name: m.candidate_field() }),
    candidateFieldLabel(property),
  );
  await canvas.findAllByRole('button', { name: m.candidate_review() });
  return canvas;
}
async function review(canvasElement: HTMLElement) {
  const canvas = await candidates(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_review() }));
  expect(canvas.getByRole('heading', { name: m.candidate_current() })).toBeTruthy();
  expect(canvas.getByRole('heading', { name: m.candidate_proposed() })).toBeTruthy();
  expect(canvas.getByText('CC0-1.0', { exact: false })).toBeTruthy();
  return canvas;
}
async function confirmation(canvasElement: HTMLElement) {
  const canvas = await review(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
  await canvas.findByRole('heading', { name: m.candidate_confirm_title({ action: m.candidate_accept() }) });
  return canvas;
}
function confirmationButton(canvasElement: HTMLElement, action: string) {
  const canvas = within(canvasElement);
  const heading = canvas.getByRole('heading', { name: m.candidate_confirm_title({ action }) });
  return within(heading.parentElement!).getByRole('button', { name: action });
}
async function adopt(canvasElement: HTMLElement) {
  const canvas = await confirmation(canvasElement);
  await userEvent.click(confirmationButton(canvasElement, m.candidate_accept()));
  await canvas.findByText(m.candidate_accepted());
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
  await canvas.findByRole('button', { name: m.candidate_review() });
  const choices = canvas.getAllByRole('checkbox');
  for (const choice of choices) if (choice.getAttribute('aria-checked') === 'true') await userEvent.click(choice);
  await userEvent.click(choices.at(-1)!);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
  await userEvent.click(confirmationButton(canvasElement, m.candidate_adopt()));
  return canvas;
}

export const Entry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('button', { name: m.candidate_entry() })).toBeTruthy();
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await canvas.findByRole('combobox', { name: m.candidate_field() });
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_close() }));
    expect(canvas.getByRole('button', { name: m.candidate_entry() })).toBeTruthy();
  },
};
export const Candidates: Story = {
  play: async ({ canvasElement }) => {
    await candidates(canvasElement);
  },
};
export const Review: Story = {
  play: async ({ canvasElement }) => {
    await review(canvasElement);
  },
};
export const Confirmation: Story = {
  args: { onRequests: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = await review(canvasElement);
    const calls = mocked(args.onRequests!).mock.calls.at(-1)![0];
    const commands = () => calls.filter((call) => call.method === 'POST');
    const field = canvas.getByRole('combobox', { name: m.candidate_field() });
    const proposed = canvas.getByRole('heading', { name: m.candidate_proposed() });
    const draft = canvas.getByRole('region', { name: m.candidate_selection_draft() });
    const selection = within(draft).getAllByRole('checkbox');
    const selected = selection.map((choice) => choice.getAttribute('aria-checked'));
    const rank = within(draft).getByRole('combobox', { name: m.candidate_rank() });
    await selectSharedOption(rank, m.candidate_rank_preferred());

    const accept = canvas.getByRole('button', { name: m.candidate_accept() });
    const reject = canvas.getByRole('button', { name: m.candidate_reject() });
    const adopt = within(draft).getByRole('button', { name: m.candidate_adopt() });
    for (const [trigger, action] of [
      [accept, m.candidate_accept()],
      [reject, m.candidate_reject()],
      [adopt, m.candidate_adopt()],
    ] as const) {
      await userEvent.click(trigger);
      const title = m.candidate_confirm_title({ action });
      const local = await canvas.findByRole('region', { name: title });
      await expect(local).toBeVisible();
      await expect(local).toHaveFocus();
      await expect(within(local).getByRole('heading', { name: title })).toBeVisible();
      await expect(canvas.getAllByRole('button', { name: m.candidate_cancel() })).toHaveLength(1);
      await expect(trigger === adopt ? trigger.nextElementSibling : trigger.parentElement!.nextElementSibling).toBe(
        local,
      );
      await expect(trigger).toBeDisabled();
      await expect(commands()).toHaveLength(0);

      await userEvent.click(within(local).getByRole('button', { name: m.candidate_cancel() }));
      await expect(canvas.queryByRole('region', { name: title })).toBeNull();
      await expect(trigger).toHaveFocus();
      await expect(trigger).toBeEnabled();
      await expect(field).toHaveTextContent(candidateFieldLabel(candidateProperty));
      await expect(canvas.getByRole('heading', { name: m.candidate_proposed() })).toBe(proposed);
      await expect(
        within(draft)
          .getAllByRole('checkbox')
          .map((choice) => choice.getAttribute('aria-checked')),
      ).toEqual(selected);
      await expect(rank).toHaveTextContent(m.candidate_rank_preferred());
      await expect(commands()).toHaveLength(0);
    }

    await userEvent.click(accept);
    await expect(commands()).toHaveLength(0);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_accept()));
    await waitFor(() =>
      expect(
        canvas.queryByRole('region', { name: m.candidate_confirm_title({ action: m.candidate_accept() }) }),
      ).toBeNull(),
    );
    await expect(commands()).toHaveLength(1);
    await expect(commands()[0]).toMatchObject({
      path: expect.stringMatching(/\/candidates\/[^/]+:accept$/),
      authorization: 'Bearer fixture',
      body: { expected_head: null },
    });
    await expect(canvas.getByRole('status')).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
  },
};
export const Pending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = await adopt(canvasElement);
    await canvas.findByText(m.candidate_pending());
    expect(canvas.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
  },
};
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await adopt(canvasElement);
    const link = await canvas.findByRole('link', { name: m.candidate_view_public() });
    expect(link.getAttribute('href')).toContain('/subjects/');
  },
};
export const StaleConflict: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await confirmation(canvasElement);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_accept()));
    await canvas.findByText(m.candidate_draft_stale());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findAllByRole('button', { name: m.candidate_review() });
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await confirmation(canvasElement);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_accept()));
    await canvas.findByText(m.candidate_denied());
    expect(canvas.queryByRole('heading', { name: m.candidate_proposed() })).toBeNull();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await selectSharedOption(
      await canvas.findByRole('combobox', { name: m.candidate_field() }),
      candidateFieldLabel(candidateProperty),
    );
    await canvas.findByText(m.candidate_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.candidate_unavailable());
  },
};

export const AcceptedUnselected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await confirmation(canvasElement);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_accept()));
    await canvas.findByText(m.candidate_accepted());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.candidate_unselected());
  },
};
export const RejectSuggestion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reject() }));
    await userEvent.click(confirmationButton(canvasElement, m.candidate_reject()));
    await canvas.findByText(m.candidate_rejected());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.candidate_rejected_state());
  },
};
async function rankedDraft(canvasElement: HTMLElement) {
  const canvas = await candidates(canvasElement, 'schema:inLanguage');
  const choices = canvas.getAllByRole('checkbox');
  expect(choices.filter((choice) => choice.getAttribute('aria-checked') === 'true')).toHaveLength(2);
  await userEvent.click(choices.at(-1)!);
  const ranks = canvas.getAllByRole('combobox', { name: m.candidate_rank() });
  await selectSharedOption(ranks.at(-1)!, m.candidate_rank_preferred());
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_more() }));
  await canvas.findByText(m.candidate_unselected());
  expect(
    canvas.getAllByRole('checkbox').filter((choice) => choice.getAttribute('aria-checked') === 'true'),
  ).toHaveLength(3);
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
  return canvas;
}
export const RankedSelection: Story = {
  args: { scenario: 'multiple' },
  play: async ({ canvasElement }) => {
    const canvas = await rankedDraft(canvasElement);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_adopt()));
    await canvas.findByText(m.candidate_selection_confirmed());
    expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toBeTruthy();
  },
};
export const StaleRankedSelection: Story = {
  args: { scenario: 'stale-selection' },
  play: async ({ canvasElement }) => {
    const canvas = await rankedDraft(canvasElement);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_adopt()));
    await canvas.findByText(m.candidate_draft_stale());
    expect(
      canvas.getAllByRole('checkbox').filter((choice) => choice.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(3);
    expect(canvas.getByRole('button', { name: m.candidate_adopt() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findAllByRole('button', { name: m.candidate_review() });
    const ranks = canvas.getAllByRole('combobox', { name: m.candidate_rank() });
    expect(ranks.at(-1)!).toHaveTextContent(m.candidate_rank_preferred());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
    await userEvent.click(confirmationButton(canvasElement, m.candidate_adopt()));
    await canvas.findByText(m.candidate_selection_confirmed());
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await selectSharedOption(
      await canvas.findByRole('combobox', { name: m.candidate_field() }),
      candidateFieldLabel(candidateProperty),
    );
    await canvas.findByText(m.candidate_empty());
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_entry() }));
    await selectSharedOption(
      await canvas.findByRole('combobox', { name: m.candidate_field() }),
      candidateFieldLabel(candidateProperty),
    );
    await canvas.findByText(m.candidate_loading());
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await confirmation(canvasElement);
    await userEvent.click(confirmationButton(canvasElement, m.candidate_accept()));
    await canvas.findByText(m.candidate_invalid());
  },
};
