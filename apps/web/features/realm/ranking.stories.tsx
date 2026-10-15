import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rankingRecord from '../../../../tests/qa/fixtures/outcomes/realm/ranking.json';
import type { UiLocale } from '../../i18n/define.ts';
import type { ThreadsPage } from '../feed/thread.ts';
import { RecordedRankingPage, rankingRecording } from './ranking-recorded-page.tsx';

const record = rankingRecord as AnswerRecord;
interface Args { persona: AnswerPersona; visit: string; loading: boolean; locale: UiLocale }
function RankingStory(args: Args) { return <RecordedRankingPage record={record} {...args} />; }
const meta = {
  title: 'Realm/Ranking recorded', component: RankingStory,
  args: { persona: 'visitor', visit: 'visit-best-all', loading: false, locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
  parameters: { docs: { description: { component: 'Captured production visits for realm/ranking. Each visit replays its own reader, page and shared Realm frame. Contract probes remain in the unit fixtures.' } } },
  render: (args, { globals }) => <RankingStory {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof RankingStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { value: 'phone' } };
const populated: Story = {
  async play({ canvasElement, args }) {
    const transport = rankingRecording(record, args.persona, args.visit);
    try {
      const sample = transport.samples.find(sample => sample.path.includes('/threads?'));
      const page = sample?.answer as ThreadsPage;
      const canvas = within(canvasElement);
      await expect(canvas.findByRole('article', { name: page.items[0]!.title })).resolves.toBeVisible();
      await expect(canvas.getAllByRole('article')).toHaveLength(page.items.length);
      const author = page.items[0]!.author;
      if (author) await expect(canvas.getAllByRole('link', { name: author.name }).length).toBeGreaterThan(0);
      await expect(canvas.queryByRole('alert')).toBeNull();
    } finally { transport.dispose(); }
  },
};
export const VisitorDesktop: Story = populated;
export const VisitorPhone: Story = { ...populated, globals: phone };
export const ContinuationDesktop: Story = { ...populated, args: { visit: 'visit-top-month-continuation' } };
export const ContinuationPhone: Story = { ...ContinuationDesktop, globals: phone };
export const TopWeek: Story = { ...populated, args: { visit: 'visit-top-week' } };
export const TopAll: Story = { ...populated, args: { visit: 'visit-top-all' } };
export const EmptyDesktop: Story = { args: { visit: 'visit-top-month-empty' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('heading', { name: 'No discussions in this period' })).resolves.toBeVisible(); } };
export const EmptyPhone: Story = { ...EmptyDesktop, globals: phone };
export const Missing: Story = { args: { visit: 'visit-best-all-missing' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('heading', { level: 1 })).resolves.toBeVisible(); } };
export const CursorRefusalDesktop: Story = { args: { visit: 'visit-top-month-invalid-cursor' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('alert')).resolves.toBeVisible(); } };
export const CursorRefusalPhone: Story = { ...CursorRefusalDesktop, globals: phone };
export const MovedContinuation: Story = { ...CursorRefusalDesktop, args: { visit: 'visit-moved' } };
export const LoadingDesktop: Story = { args: { loading: true },
  async play({ canvasElement }) { await expect(canvasElement.querySelector('[aria-busy="true"]')).not.toBeNull(); } };
export const LoadingPhone: Story = { ...LoadingDesktop, globals: phone };
export const StrangerPublic: Story = { ...populated, args: { persona: 'stranger' } };
export const MemberPublic: Story = { ...populated, args: { persona: 'member' } };
export const OwnerPublic: Story = { ...populated, args: { persona: 'owner' } };
export const ModeratorPublic: Story = { ...populated, args: { persona: 'moderator' } };
export const OperatorPublic: Story = { ...populated, args: { persona: 'operator' } };
const privateLanding: Story = { args: { visit: 'visit-private-best-all' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('heading', { level: 1 })).resolves.toBeVisible();
    await expect(within(canvasElement).queryByRole('article')).toBeNull(); } };
export const VisitorPrivate: Story = privateLanding;
export const StrangerPrivate: Story = { ...privateLanding, args: { persona: 'stranger', visit: 'visit-private-best-all' } };
export const OperatorPrivate: Story = { ...privateLanding, args: { persona: 'operator', visit: 'visit-private-best-all' } };
export const MemberPrivate: Story = { ...populated, args: { persona: 'member', visit: 'visit-private-best-all' } };
export const OwnerPrivate: Story = { ...populated, args: { persona: 'owner', visit: 'visit-private-best-all' } };
export const ModeratorPrivate: Story = { ...populated, args: { persona: 'moderator', visit: 'visit-private-best-all' } };
export const TraditionalChinese: Story = { ...populated, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { ...populated, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { ...populated, globals: { locale: 'ja' } };
export const Korean: Story = { ...populated, globals: { locale: 'ko' } };
export const German: Story = { ...populated, globals: { locale: 'de' } };
export const French: Story = { ...populated, globals: { locale: 'fr' } };
export const Spanish: Story = { ...populated, globals: { locale: 'es' } };
