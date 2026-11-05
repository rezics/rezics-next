import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { QuestionManagementContent } from '../ratings/question-management/page';
import type { QuestionManagementHistoryRead, QuestionManagementPageData } from '../ratings/question-management/types';

const realmId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
const activeId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702101';
const retiredId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702102';
const page: QuestionManagementPageData = {
  viewer: { accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702002' },
  realmId,
  directory: {
    ratingQuestions: [
      {
        id: activeId,
        realmId,
        meaning: 'Rate translation accuracy independently from enjoyment of the original work.',
        canonicalLabel: 'Translation accuracy',
        label: 'Translation accuracy',
        labelRevision: 1,
        revision: 1,
        grain: 'release',
        scale: { min: 0, max: 20, displayStep: 2 },
        lifecycle: { state: 'active', revision: 1 },
      },
    ],
    next: null,
  },
  actions: { create: { method: 'POST', href: `/v1/realms/${realmId}/rating-questions` } },
  selected: {
    question: {
      id: retiredId,
      realmId,
      meaning:
        'Rate translation accuracy independently from enjoyment of the original work. This long text remains readable at narrow widths and wraps without changing the immutable meaning.',
      canonicalLabel: 'Translation accuracy',
      label: 'Translation clarity',
      labelRevision: 2,
      revision: 1,
      grain: 'release',
      scale: { min: 0, max: 20, displayStep: 2 },
      lifecycle: { state: 'retired', revision: 2 },
    },
    readback: `/v1/rating-questions/${retiredId}`,
    history: `/v1/rating-questions/${retiredId}/labels`,
    actions: {
      caption: { method: 'PUT', href: `/v1/rating-questions/${retiredId}/label`, expectedLabelRevision: 2 },
      lifecycle: { method: 'POST', href: `/v1/rating-questions/${retiredId}/$restore`, expectedLifecycleRevision: 2 },
    },
  },
};

const activePage: QuestionManagementPageData = {
  ...page,
  directory: { ratingQuestions: page.directory.ratingQuestions, next: null },
  selected: {
    question: page.directory.ratingQuestions[0]!,
    readback: `/v1/rating-questions/${activeId}`,
    history: `/v1/rating-questions/${activeId}/labels`,
    actions: {
      caption: { method: 'PUT', href: `/v1/rating-questions/${activeId}/label`, expectedLabelRevision: 1 },
      lifecycle: {
        method: 'POST',
        href: `/v1/rating-questions/${activeId}/$retire`,
        expectedLifecycleRevision: 1,
      },
    },
  },
};
const unavailablePage: QuestionManagementPageData = {
  ...page,
  actions: { create: null },
  selected: page.selected ? { ...page.selected, actions: { caption: null, lifecycle: null } } : null,
};
const captionHistory: QuestionManagementHistoryRead = {
  state: 'ready',
  questionId: retiredId,
  cursor: null,
  page: {
    labels: [
      {
        questionId: retiredId,
        labelRevision: 1,
        label: 'Translation accuracy',
        at: null,
        author: { id: '019a1b2c-3d4e-7f00-8a00-5ab1ec702003', kind: 'actor', state: 'deleted' },
      },
      {
        questionId: retiredId,
        labelRevision: 2,
        label: 'Translation clarity',
        at: '2026-11-01T12:00:00.000Z',
        author: {
          id: page.viewer.accountId,
          kind: 'actor',
          state: 'active',
          handle: null,
          displayName: null,
          automated: false,
          operatorId: null,
        },
      },
    ],
    next: 'recorded caption continuation',
  },
};

const meta = {
  title: 'Ratings/Realm question management',
  component: QuestionManagementContent,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Recorded closed management source and caption history values. Command callbacks are presentation-only; the native journeys are covered separately.',
      },
    },
  },
  args: {
    page,
    address: { selectedQuestionId: retiredId, cursor: null },
    onSelect: () => undefined,
    onNext: () => undefined,
    onCreate: () => undefined,
    onCaption: () => undefined,
    onLifecycle: () => undefined,
  },
} satisfies Meta<typeof QuestionManagementContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RetiredDefinitionInspection: Story = {};

export const ActiveSelection: Story = {
  args: { page: activePage, address: { selectedQuestionId: activeId, cursor: null } },
};

export const CreationReview: Story = {
  args: { page: { ...page, selected: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_question_create() }));
    await userEvent.type(
      canvas.getByLabelText(m.realm_question_management_meaning()),
      'Rate adaptation fidelity independently.',
    );
    await userEvent.type(canvas.getByLabelText(m.home_question_label()), 'Adaptation fidelity');
    await userEvent.click(canvas.getByRole('button', { name: m.realm_question_review_definition() }));
    await expect(canvas.getByRole('button', { name: m.realm_question_confirm_create() })).toBeVisible();
  },
};

export const CaptionHistory: Story = { args: { history: captionHistory } };

export const StaleConflict: Story = {
  args: { commandStates: { caption: 'stale' }, requireFreshInspection: true },
  play: async ({ canvasElement }) => {
    const statuses = within(canvasElement).getAllByRole('status');
    await expect(statuses.some((status) => status.textContent === m.realm_question_action_conflict())).toBe(true);
  },
};

export const StaleHistoryCursor: Story = {
  args: { history: { state: 'stale-cursor', questionId: retiredId, cursor: 'recorded stale cursor' } },
};

export const UnavailableAdvice: Story = { args: { page: unavailablePage } };

export const Phone390: Story = {
  args: { page: activePage, address: { selectedQuestionId: activeId, cursor: null }, history: captionHistory },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const edit = canvas.getByRole('button', { name: m.realm_question_caption_edit() });
    edit.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('heading', { name: m.realm_question_caption_edit() })).toHaveFocus();
    const caption = canvas.getByLabelText(m.home_question_label());
    await userEvent.clear(caption);
    await userEvent.type(caption, 'A long replacement caption that stays readable at narrow widths.');
    await userEvent.click(canvas.getByRole('button', { name: m.realm_question_review_definition() }));
    await expect(canvas.getByText('A long replacement caption that stays readable at narrow widths.')).toBeVisible();
  },
};

export const Desktop1280: Story = {
  args: { page, history: captionHistory },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const restore = canvas.getByRole('button', { name: m.realm_question_restore() });
    restore.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: m.container_lifecycle_confirm() })).toBeVisible();
  },
};
