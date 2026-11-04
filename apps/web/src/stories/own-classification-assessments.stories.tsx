import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { OwnClassificationsWorkspace } from '../ratings/own-classifications/page';
import type {
  OwnClassification,
  OwnClassificationsPage,
  OwnClassificationsState,
} from '../ratings/own-classifications/types';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const subjectId = '00000000-0000-8000-8000-000000000010';
const associationId = '00000000-0000-8000-8000-000000000011';
const targetId = '00000000-0000-8000-8000-000000000012';
const path = `/v1/subjects/${subjectId}/classification-associations/${associationId}/assessment`;
const available: OwnClassification = {
  state: 'available',
  subjectId,
  associationId,
  subject: { id: subjectId, type: 'schema:Book', label: 'Own-page subject', href: `/v1/subjects/${subjectId}` },
  target: { id: targetId, type: 'skos:Concept', label: 'Own-page concept', href: `/v1/subjects/${targetId}` },
  association: {
    subjectId,
    associationId,
    targetId,
    slotId: associationId,
    contextId: PAGE_GLOBAL_CONTEXT,
    origin: 'global',
    property: 'schema:keywords',
    release: 'release',
    revision: 1,
    bindingHash: 'ab'.repeat(32),
    statementDigest: 'cd'.repeat(32),
    qualifiersDigest: 'ef'.repeat(32),
  },
  own: { assessment: 'support', falsePositive: true, revision: '1', pending: 'pending' },
  aggregate: { associationId, state: 'suppressed', pending: 'unknown' },
  actions: {
    state: 'editable',
    set: `${path}?expectedRevision=1`,
    clear: `${path}?expectedRevision=1`,
    readback: path,
  },
};
type Mode =
  | 'ready'
  | 'empty'
  | 'sparse'
  | 'withheld'
  | 'binding-mismatch'
  | 'read-only'
  | 'unavailable'
  | 'long'
  | 'uncertain'
  | 'selected'
  | 'preparing'
  | 'withdraw-only'
  | 'identity-changed'
  | 'question-changed';
function sample(mode: Mode): OwnClassificationsPage {
  let row = structuredClone(available);
  if (mode === 'long' && row.state === 'available') {
    row.subject.label = 'A long disclosed title with several parts and a changing current destination · '.repeat(20);
    row.target.label = 'A carefully qualified classification concept · '.repeat(20);
  }
  if (mode === 'read-only') row.actions = { state: 'read-only', set: null, clear: null, readback: path };
  if (mode === 'withdraw-only') row.actions = { state: 'withdraw-only', set: null, clear: `${path}?expectedRevision=1`, readback: null };
  if (mode === 'identity-changed' && row.state === 'available') {
    row.subject.label = 'Current subject identity after replacement';
    row.association.revision = 2;
  }
  if (mode === 'question-changed' && row.state === 'available') {
    row.target.label = 'Current classification concept after question revision';
    row.association.revision = 2;
  }
  if (mode === 'withheld' || mode === 'binding-mismatch')
    row = {
      ...row,
      state: 'withheld',
      subject: null,
      target: null,
      association: null,
      aggregate: null,
      own: { ...row.own, pending: 'unknown' },
      actions: {
        state: mode === 'withheld' ? 'withdraw-only' : 'withheld',
        set: null,
        readback: null,
        clear: mode === 'withheld' ? `${path}?expectedRevision=1` : null,
      },
    };
  return {
    viewer: { accountId: subjectId },
    inventory: { kind: 'current-retained', complete: false, generation: '1', cleanup: 'settled' },
    items: mode === 'empty' || mode === 'sparse' ? [] : [row],
    traversal: mode === 'sparse' ? 'more' : 'complete',
    next: mode === 'sparse' ? 'opaque raw continuation' : null,
  };
}
function Story({ mode }: { mode: Mode }) {
  const [page, replace] = useState(() => sample(mode));
  const [state, setState] = useState<OwnClassificationsState>(
    mode === 'unavailable' ? 'unavailable' : mode === 'preparing' ? 'preparing' : 'ready',
  );
  return (
    <OwnClassificationsWorkspace
      state={state}
      page={page}
      frontier={{ cursor: null, selected: mode === 'selected' ? { subjectId, associationId } : null }}
      locale={getLocale()}
      isCurrent={() => true}
      onRetry={async () => {
        replace(sample('sparse'));
        setState('ready');
      }}
      onNext={() => replace(sample('empty'))}
      commands={{
        read: {
          state: 'ready',
          page,
          frontier: { cursor: null, selected: null },
          subject: subjectId,
          locale: getLocale(),
          source: 'content.classification-ballot-own-page.v1',
          credential: 'ab'.repeat(32),
          observation: 'cd'.repeat(32),
        },
        csrfToken: () => 'story-csrf',
        send: async () => ({ kind: mode === 'uncertain' ? 'uncertain' : 'acknowledged' }),
        review: async () => ({
          kind: 'current',
          own: {
            associationId,
            hasBallot: false,
            assessment: null,
            falsePositive: false,
            revision: '2',
            pending: true,
          },
        }),
      }}
    />
  );
}
const meta = {
  title: 'Pages/Library/My classification assessments',
  component: Story,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Recorded native response shapes presented with a supplied command adapter. The examples show returned states; the Kernel journey separately exercises current Access and native writes.',
      },
    },
  },
} satisfies Meta<typeof Story>;
export default meta;
type StoryType = StoryObj<typeof meta>;
export const Ready: StoryType = {
  args: { mode: 'ready' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.subject_classification_assessment_inspect() }));
    await expect(canvas.getByText(m.subject_classification_assessment_provenance())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.subject_classification_assessment_withdraw() })).toBeVisible();
  },
};
export const Empty: StoryType = { args: { mode: 'empty' } };
export const Sparse: StoryType = { args: { mode: 'sparse' } };
export const Withheld: StoryType = { args: { mode: 'withheld' } };
export const BindingMismatch: StoryType = { args: { mode: 'binding-mismatch' } };
export const ReadOnly: StoryType = { args: { mode: 'read-only' } };
export const RevokedSet: StoryType = { args: { mode: 'withdraw-only' } };
export const IdentityChanged: StoryType = { args: { mode: 'identity-changed' } };
export const QuestionChanged: StoryType = { args: { mode: 'question-changed' } };
export const Unavailable: StoryType = { args: { mode: 'unavailable' } };
export const LongLocalized: StoryType = { args: { mode: 'long' } };

export const UncertainWithdrawal: StoryType = {
  args: { mode: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.subject_classification_assessment_inspect() }));
    await userEvent.click(canvas.getByRole('button', { name: m.subject_classification_assessment_withdraw() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_my_ratings_confirm_clear() }));
    await expect(canvas.getByText(m.subject_classification_assessment_uncertain())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.own_classifications_readback() }));
    await expect(canvas.getByText(m.own_classifications_readback_separate())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.subject_classification_assessment_retry() })).toBeEnabled();
  },
};

export const WithheldClearRequiresPreparation: StoryType = {
  args: { mode: 'withheld' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.subject_classification_assessment_inspect() }));
    await expect(canvas.getByText(m.own_classifications_withheld())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.subject_classification_assessment_withdraw() })).toBeVisible();
  },
};
export const Phone: StoryType = {
  args: { mode: 'long' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const Desktop: StoryType = {
  args: { mode: 'ready' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const SelectedOffPage: StoryType = { args: { mode: 'selected' } };
export const Preparing: StoryType = { args: { mode: 'preparing' } };
