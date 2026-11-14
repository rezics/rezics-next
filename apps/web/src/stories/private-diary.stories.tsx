import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { ReportedYearPanel } from '../library/private-diary/year-summary';
import type { ReportedYearSummary } from '../library/private-diary/native';
import { PageStory, PatternStory } from './page';
import { diarySessionId, setPrivateDiaryScenario, type PrivateDiaryScenario } from '../kernel/fake/private-diary';

const meta = {
  title: 'Library/Private diary',
  id: 'pages-library-private-diary',
  beforeEach() {
    setPrivateDiaryScenario();
    return () => setPrivateDiaryScenario();
  },
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'Actual history and occurrence routes use opt-in constructed native contract shapes. Journal forms remain manually editable. Summary panels retain supplied responses. These examples do not establish native, browser or compiler acceptance.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const counts = (n = '0') => ({
  completedOccurrences: n,
  distinctCompletedSubjects: n,
  repeatOccurrences: '0',
  completedOccurrencesWithUnknownProfile: '0',
  finishPrecision: { year: n, month: '0', day: '0' },
});
const summary: ReportedYearSummary = {
  ...counts('1'),
  scope: 'retained_native_sessions',
  year: 2020,
  calendar: 'gregorian',
  dateSource: 'explicitly_reported_journal_finish',
  months: Array.from({ length: 12 }, (_, i) => ({ ...counts(), month: i + 1 })),
  monthUnallocated: counts('1'),
  coverage: {
    nativeSessions: 'complete',
    initializedSessions: '3',
    retainedSessions: '3',
    completedOccurrencesWithMissingFinish: '2',
    completedOccurrencesWithUnsupportedFinish: '0',
    otherHistory: 'unavailable',
    unitMeaning: 'not_evaluated',
  },
  currentness: { state: 'snapshot', revision: 'supplied-snapshot' },
};
function panel(value: ReportedYearSummary | null) {
  return (
    <PatternStory visitor="Signed In" path="/library/history?year=2020">
      <main className="mx-auto max-w-4xl p-4">
        <ReportedYearPanel
          year={2020}
          result={value ? { kind: 'ready', value } : { kind: 'unavailable' }}
          retry={() => {}}
        />
      </main>
    </PatternStory>
  );
}
export const YearOnlyUnallocated: Story = { render: () => panel(summary) };
export const EmptyYear: Story = { render: () => panel({ ...summary, ...counts(), monthUnallocated: counts() }) };
export const PreparingOrUnavailable: Story = { render: () => panel(null) };

function diaryRoute(scenario: PrivateDiaryScenario, path = '/library/history', instructions: string): Story {
  return {
    beforeEach() {
      setPrivateDiaryScenario(scenario);
    },
    render: () => <PageStory visitor="Signed In" path={path} />,
    parameters: { docs: { description: { story: instructions } } },
  };
}
const occurrencePath = `/library/progress/${diarySessionId}`;
export const ReadingTimeline: Story = {
  ...diaryRoute(
    'reading',
    '/library/history',
    'Recorded UTC days group adjacent native occurrences. Two rows share a day; an active visit, a completed visit and an abandoned visit retain their supplied order. Open an occurrence for private writing and native amount history. Next opens the older window; Previous retains the admitted frontier.',
  ),
  name: 'History · dates and varied occurrences',
};
export const PrivateWriting: Story = {
  ...diaryRoute(
    'reading',
    occurrencePath,
    'Read the private reflection, choose Write or revise your journal, edit it, Review, then Save. The original and proposed values are compared at the captured journal revision. Cancel before dispatch discards only this draft. Change any field or choose Clear, then follow Library or use Back to open the shared Stay/Leave dialog. Stay keeps exact selections and focus; Leave discards only local drafts. An untouched editor and a settled save without later edits do not prompt. Progress revision and public publication remain independent.',
  ),
  name: 'Journal · read, edit, review and cancel',
};
export const LongMultilingualNote: Story = {
  ...diaryRoute(
    'long-note',
    occurrencePath,
    'Long Japanese, Chinese, Korean, English and Arabic paragraphs remain literal private text. Read the ending, edit it and compare both versions. Phone controls and the review save row stay usable without horizontal scrolling.',
  ),
  name: 'Journal · long multilingual writing',
};
export const FirstUse: Story = {
  ...diaryRoute(
    'first-use',
    '/library/history',
    'An empty first history window explains how occurrences and private notes relate and offers Library. It is distinct from a sparse window with a continuation.',
  ),
  name: 'History · first use',
};
export const FirstJournalEntry: Story = {
  ...diaryRoute(
    'first-use',
    occurrencePath,
    'The current occurrence exists with no private reflection. Open its editor to write the first entry; no public log is created.',
  ),
  name: 'Journal · first private entry',
};
export const CurrentSubjectUnavailable: Story = {
  ...diaryRoute(
    'subject-unavailable',
    occurrencePath,
    'The current Subject projection is unavailable while the authorized occurrence and private journal remain independently readable and editable. No title hydration request is added.',
  ),
  name: 'Journal · current Subject unavailable',
};
export const SparseContinuation: Story = {
  ...diaryRoute(
    'sparse',
    '/library/history',
    'The first native window has no visible rows and still has Next. Continue to the same-day occurrences and then the older window. Empty does not imply completion; no first-use message appears here.',
  ),
  name: 'History · sparse native continuation',
};
export const ExactFailedSaveRecovery: Story = {
  ...diaryRoute(
    'failed-save',
    occurrencePath,
    'Edit the reflection, Review and Save. The constructed producer saves once and loses the response. Read current values to see revision 4 separately; the retained original comparison still shows revision 3. Continue editing the fields without changing that sealed request. Try leaving: the dialog distinguishes the uncertain save from your unsent edits. Stay retains both; deliberate Leave discards only local edits and cannot undo the dispatched save. Retry sends exactly the original body, credential, key and revision, returning its recorded outcome without applying the edit twice. Any edits made after dispatch remain a draft after Retry succeeds.',
  ),
  name: 'Journal · lost response and exact original retry',
};
export const ConflictingRevision: Story = {
  ...diaryRoute(
    'conflict',
    occurrencePath,
    'Edit, Review and Save. A constructed correction from another device conflicts. Read current values, compare the retained draft with the latest journal and explicitly review that revision before saving a new command.',
  ),
  name: 'Journal · compare after a revision conflict',
};
export const HistoryUnavailable: Story = {
  ...diaryRoute(
    'unavailable',
    '/library/history',
    'The first history read is unavailable while the independent native summary remains readable. Retry rereads the current address and supplies the original page; it never claims an empty history.',
  ),
  name: 'History · unavailable and retry',
};

export const OccurrenceRetirementReview: Story = {
  ...diaryRoute(
    'reading',
    occurrencePath,
    'An unsent retirement review shows its captured occurrence revision and deliberate confirmation. Cancel returns focus to the launcher without a mutation or any change to the independent journal draft. Reopen has its own review. After dispatch, recovery retains the original action and key, separates Retry from reading the current occurrence, and requires a fresh revision review after conflict. This story stops at unsent review; it does not supply a lifecycle response or establish native recovery acceptance.',
  ),
  name: 'Occurrence · cancel before dispatch',
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_occurrence_retire() }));
  },
};
