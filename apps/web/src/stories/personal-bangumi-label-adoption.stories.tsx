import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type {
  BangumiCommand,
  BangumiImportPort,
  BangumiLabelPanelState,
} from '../library/personal-bangumi-import/contract';
import { BangumiLabelAdoption, emptyBangumiLabelPanel } from '../library/personal-bangumi-import/labels';
import type { BangumiVisit } from '../library/personal-bangumi-import/visit';

const uploadId = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const rowRevision = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const reviewToken = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';
const labelId = '0192f3a0-6c1e-7b2a-9d4e-00000000eeee';
const assignmentId = '0192f3a0-6c1e-7b2a-9d4e-00000000ffff';
const custody = { viewer: 'alice', csrfToken: 'csrf-story', credential: 'encrypted-session-envelope' };

function visit(): BangumiVisit {
  return {
    identity: 1,
    subject: 'alice',
    csrfToken: 'csrf-story',
    locale: 'en',
    controller: new AbortController(),
    current: () => true,
    retire() {},
  };
}

const review = {
  token: reviewToken,
  rowRevision,
  subject: { subjectId, identityEpoch: '12', acceptingType: 'ex:Game', releaseDigest: 'a'.repeat(64) },
  evidence: 'known' as const,
  items: [
    { index: 0, source: 'role-playing', status: 'ready' as const, duplicateOf: null, target: { labelId, revision: 4 } },
    {
      index: 1,
      source: 'awaiting-assignment',
      status: 'ready' as const,
      duplicateOf: null,
      target: { name: 'awaiting assignment' },
    },
  ],
};

function port(): BangumiImportPort {
  const fake = {
    async preview() {
      return { kind: 'unavailable' as const };
    },
    async page() {
      return { kind: 'unavailable' as const };
    },
    async review() {
      return { kind: 'unavailable' as const };
    },
    async apply() {
      return { kind: 'unavailable' as const };
    },
    async admitSource() {
      return { kind: 'unavailable' as const };
    },
    async cancel() {
      return { kind: 'unavailable' as const };
    },
    async delete() {
      return { kind: 'unavailable' as const };
    },
    async tags(command: Extract<BangumiCommand, { kind: 'tags' }>) {
      return {
        kind: 'tags' as const,
        custody,
        page: {
          ordinal: command.ordinal,
          rowRevision,
          evidence: 'invalid' as const,
          tags: [{ index: 0, value: ['unsafe', 4], status: 'invalid' as const, proposedName: null }],
          next: null,
          labels: null,
        },
      };
    },
    async searchLabels() {
      return { kind: 'label-options' as const, labels: [] };
    },
    async reviewLabels() {
      return { kind: 'unavailable' as const };
    },
    async applyLabels() {
      return { kind: 'unavailable' as const };
    },
    async readAssignments() {
      return {
        kind: 'assignments' as const,
        subjectId,
        assignments: [{ id: assignmentId, labelId, name: 'role-playing', revision: 3 }],
      };
    },
    async inspect() {
      return { entry: { status: 'unavailable' as const, reason: 'not_read_in_label_story' }, vote: null };
    },
  } satisfies BangumiImportPort;
  return fake;
}

function Example({ initial }: { initial: BangumiLabelPanelState }) {
  const [panel, setPanel] = useState(initial);
  return (
    <div className="mx-auto max-w-3xl p-6">
      <BangumiLabelAdoption
        uploadId={uploadId}
        ordinal={0}
        rowRevision={rowRevision}
        port={port()}
        visit={visit()}
        panel={panel}
        onChange={(update) => setPanel((current) => update(current))}
        disabled={false}
      />
    </div>
  );
}

const meta = {
  title: 'Library/Personal Bangumi label adoption',
  component: Example,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

const invalid = emptyBangumiLabelPanel(rowRevision);
invalid.custody = custody;
invalid.pages = [
  {
    ordinal: 0,
    rowRevision,
    evidence: 'invalid',
    tags: [{ index: 0, value: ['unsafe', 4], status: 'invalid', proposedName: null }],
    next: null,
    labels: null,
  },
];

const partial = emptyBangumiLabelPanel(rowRevision);
partial.custody = custody;
partial.pages = [{ ordinal: 0, rowRevision, evidence: 'known', tags: [], next: null, labels: null }];
partial.labels = {
  review,
  confirmed: true,
  outcomes: [
    {
      index: 0,
      status: 'assigned',
      label: { id: labelId, revision: 5 },
      assignment: { id: assignmentId, revision: 3 },
      created: false,
    },
    { index: 1, status: 'failed', label: { id: uploadId, revision: 1 }, assignment: null, created: true },
  ],
};
partial.result = { uploadId, ordinal: 0, outcomes: partial.labels.outcomes, remaining: [1] };
partial.assignments = [{ id: assignmentId, labelId, name: 'role-playing', revision: 3 }];
partial.assignmentState = 'loaded';

const uncertain = emptyBangumiLabelPanel(rowRevision);
uncertain.custody = custody;
uncertain.labels = { review, confirmed: false, outcomes: [] };
uncertain.command = { kind: 'apply-labels', uploadId, ordinal: 0, reviewToken, custody };

export const InvalidMixedEvidence = { args: { initial: invalid } } satisfies Story;
export const PartialCreationAndAssignment = { args: { initial: partial } } satisfies Story;
export const UncertainCommand = { args: { initial: uncertain } } satisfies Story;
