import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReportedYearPanel } from '../library/private-diary/year-summary';
import type { ReportedYearSummary } from '../library/private-diary/native';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Library/Private diary',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        component:
          'Supplied summary responses in the existing connected story host. Native bucket navigation and occurrence assessment are unavailable. Browser and publisher verification remains with integration.',
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
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
export const Phone: Story = { ...YearOnlyUnallocated, globals: { viewport: { value: 'phone390', isRotated: false } } };
