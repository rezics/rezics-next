import type { Meta, StoryObj } from '@storybook/react-vite';
import { QuestionManagementContent } from '../ratings/question-management/page';
import type { QuestionManagementPageData } from '../ratings/question-management/types';

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

const meta = {
  title: 'Ratings/Realm question management',
  component: QuestionManagementContent,
  parameters: { layout: 'fullscreen' },
  args: {
    page,
    address: { selectedQuestionId: retiredId, cursor: null },
    onSelect: () => undefined,
    onNext: () => undefined,
  },
} satisfies Meta<typeof QuestionManagementContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RetiredDefinitionInspection: Story = {};
