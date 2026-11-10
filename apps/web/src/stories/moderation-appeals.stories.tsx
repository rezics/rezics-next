import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ModerationAppealsView } from '../moderation/appeals-tab';
import type { Appeal } from '../moderation/appeals-read';
import type { ModerationTarget } from '../moderation/reports-page';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { currentText, moderationQueueFixture, queueViewports } from './patterns/board-report-queue/fixture';

// This fixed response is copied from the native fixture's successful GET /v1/boards/:id/appeals receipt.
const pendingAppeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  appellantId: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
  statement: 'I did not intend to share identifying information. Please review the decision independently.',
  createdAt: '2026-10-30T01:00:00.000Z',
  decision: {
    statement: 'The reply is withheld while its personal information is reviewed.',
    target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  },
  canResolve: true,
} satisfies Appeal;

// The native post GET returns a denial after takedown, so the real page resolves the target to null.
const withheldTarget: ModerationTarget = {
  key: `post:${pendingAppeal.decision.target.id}`,
  kind: 'post',
  value: null,
};

// Illustrative composition of the existing appeal and current-target fixtures; long IDs/reason are UI stress data,
// not a native receipt or proof.
const longId = (value: string) => `${value}-${value}-${value}`;
const longTargetId = longId(pendingAppeal.decision.target.id);
const longAppeal = {
  ...pendingAppeal,
  id: longId(pendingAppeal.id),
  decisionId: longId(pendingAppeal.decisionId),
  statement: Array.from(
    { length: 8 },
    (_, index) =>
      `Appeal reason paragraph ${index + 1}: ${pendingAppeal.statement} The complete statement remains readable for independent review.`,
  ).join('\n\n'),
  decision: { ...pendingAppeal.decision, target: { kind: 'post' as const, id: longTargetId } },
} satisfies Appeal;
const longCurrentTarget: ModerationTarget = {
  ...moderationQueueFixture.targets[0]!,
  key: `post:${longTargetId}`,
};

const meta = {
  title: 'Moderation/Moderation appeals',
  id: 'pages-moderation-appeals',
  component: ModerationAppealsView,
  parameters: { layout: 'fullscreen', viewport: { options: queueViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/boards/community/moderation?tab=appeals">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  // Existing Pending/Empty IDs remain stable. Controls also expose recovery and sparse-page states.
  argTypes: {
    state: { control: 'select', options: ['ready', 'loading', 'unavailable', 'stale', 'closed'] },
    next: { control: 'text', description: 'An opaque native continuation; Empty with next is a sparse page.' },
    postId: {
      control: 'text',
      description: 'Return context only; Appeals still shows the containing thread or board.',
    },
  },
  args: { next: null, onRetry: () => {}, onRestart: () => {} },
} satisfies Meta<typeof ModerationAppealsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: { appeals: [pendingAppeal], targets: [withheldTarget] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const main = await canvas.findByRole('main');
    const view = within(main);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(m.moderation_appeals_heading());
    const reports = view.getByRole('link', { name: m.moderation_reports_tab() });
    const statement = view.getByRole('textbox', { name: m.moderation_statement_label() });
    const uphold = view.getByRole('button', { name: m.moderation_appeal_uphold_action() });
    const article = view.getByRole('article', {
      name: new RegExp(`${m.moderation_appeals_tab()}.*${m.moderation_queue_post()}`),
    });
    const expectTargetIdentityWithheld = async () => {
      const targetId = pendingAppeal.decision.target.id;
      await expect(canvasElement.textContent).not.toContain(targetId);
      const renderedAttributes = [canvasElement, ...canvasElement.querySelectorAll('*')]
        .flatMap((element) => [...element.attributes].map(({ name, value }) => `${name}=${value}`))
        .join('\n');
      await expect(renderedAttributes).not.toContain(targetId);
    };

    await expect(article.querySelector('h2')).toHaveTextContent(m.moderation_queue_post());
    await expectTargetIdentityWithheld();
    await expect(article.querySelector('a')).toBeNull();
    await expect(view.getByRole('heading', { level: 3, name: m.moderation_current_target_label() })).toBeVisible();
    await expect(article.querySelector('time')).toHaveAttribute('dateTime', pendingAppeal.createdAt);

    // The shell's skip target anchors keyboard progression inside the appeals page.
    main.focus();
    await expect(main).toHaveFocus();
    await userEvent.tab();
    await expect(reports).toHaveFocus();
    await userEvent.tab();
    await expect(statement).toHaveFocus();
    await expect(uphold).toBeDisabled();
    await userEvent.type(statement, 'Illustrative independent review statement.');
    await expect(statement).toHaveValue('Illustrative independent review statement.');
    await expect(uphold).toBeEnabled();
    await userEvent.tab();
    await expect(uphold).toHaveFocus();

    await expect(view.getByText(pendingAppeal.decision.statement)).toBeInTheDocument();
    await expect(view.getByText(pendingAppeal.statement)).toBeInTheDocument();
    await expect(view.getByRole('blockquote').textContent).toBe(m.moderation_target_unavailable());
    await expect(view.queryByText(m.moderation_appeals_empty())).not.toBeInTheDocument();

    await userEvent.click(view.getByText(m.reporter_status_reference(), { exact: true }));
    const referenceDetails = view.getByText(m.reporter_status_reference(), { exact: true }).closest('details');
    if (!referenceDetails) throw new Error('Appeal Reference details were not rendered.');
    await expect(referenceDetails).toHaveAttribute('open');
    await expectTargetIdentityWithheld();

    const references = within(referenceDetails);
    const appealReferenceLabel = references.getByText(m.moderation_case_details_appeal_id(), { exact: true });
    const appealReferenceValue = references.getByText(pendingAppeal.id, { exact: true });
    await expect(appealReferenceLabel).toBeVisible();
    await expect(appealReferenceValue).toBeVisible();
    if (!appealReferenceLabel.parentElement?.contains(appealReferenceValue))
      throw new Error('The appeal ID must remain under its Appeal ID reference label.');

    const decisionReferenceLabel = references.getByText(m.moderation_case_details_decision_id(), { exact: true });
    const decisionReferenceValue = references.getByText(pendingAppeal.decisionId, { exact: true });
    await expect(decisionReferenceLabel).toBeVisible();
    await expect(decisionReferenceValue).toBeVisible();
    if (!decisionReferenceLabel.parentElement?.contains(decisionReferenceValue))
      throw new Error('The decision ID must remain under its Decision ID reference label.');
  },
};

export const Empty: Story = {
  args: { appeals: [], targets: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const view = within(await canvas.findByRole('main'));
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(m.moderation_appeals_heading());
    await expect(view.getByText(m.moderation_appeals_empty())).toBeVisible();
    await expect(view.queryByRole('list')).not.toBeInTheDocument();
    await expect(view.queryByRole('textbox')).not.toBeInTheDocument();
  },
};

export const IllustrativeCurrentTargetWithLongReferences: Story = {
  name: 'Illustrative current target with long references',
  args: { appeals: [longAppeal], targets: [longCurrentTarget] },
  play: async ({ canvasElement }) => {
    const view = within(await within(canvasElement).findByRole('main'));
    await expect(view.getByRole('heading', { level: 3, name: m.moderation_current_target_label() })).toBeVisible();
    await expect(view.getByText(m.reporter_status_post(), { exact: true })).toBeVisible();
    await expect(view.getByText(currentText)).toBeVisible();
    await expect(view.getByText(longAppeal.statement)).toBeVisible();
    await userEvent.click(view.getByText(m.reporter_status_reference(), { exact: true }));
    await expect(view.getByText(longAppeal.id, { exact: true })).toBeVisible();
    await expect(view.getByText(longAppeal.decisionId, { exact: true })).toBeVisible();
    await expect(view.getByText(longTargetId, { exact: true })).toBeVisible();
  },
};
