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
type Mode = 'ready' | 'empty' | 'sparse' | 'withheld' | 'binding-mismatch' | 'read-only' | 'unavailable' | 'long';
function sample(mode: Mode): OwnClassificationsPage {
  let row = structuredClone(available);
  if (mode === 'long' && row.state === 'available') {
    row.subject.label = 'A long disclosed title with several parts and a changing current destination · '.repeat(20);
    row.target.label = 'A carefully qualified classification concept · '.repeat(20);
  }
  if (mode === 'read-only') row.actions = { state: 'read-only', set: null, clear: null, readback: path };
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
  const [state, setState] = useState<OwnClassificationsState>(mode === 'unavailable' ? 'unavailable' : 'ready');
  return (
    <OwnClassificationsWorkspace
      state={state}
      page={page}
      frontier={{ cursor: null, selected: null }}
      locale={getLocale()}
      isCurrent={() => true}
      onRetry={async () => {
        replace(sample('sparse'));
        setState('ready');
      }}
      onNext={() => replace(sample('empty'))}
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
          'Source-contract presentation examples. Production explicitly stays unavailable until generated Client delivery; command and uncertain-clear stories follow that binding.',
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
    await expect(canvas.getByText(m.own_classifications_commands_unavailable())).toBeVisible();
  },
};
export const Empty: StoryType = { args: { mode: 'empty' } };
export const Sparse: StoryType = { args: { mode: 'sparse' } };
export const Withheld: StoryType = { args: { mode: 'withheld' } };
export const BindingMismatch: StoryType = { args: { mode: 'binding-mismatch' } };
export const ReadOnly: StoryType = { args: { mode: 'read-only' } };
export const Unavailable: StoryType = { args: { mode: 'unavailable' } };
export const LongLocalized: StoryType = { args: { mode: 'long' } };
