import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rankingRecord from '../../../../tests/qa/fixtures/outcomes/realm/ranking.json';
import type { UiLocale } from '../../i18n/define.ts';
import { RecordedRankingPage } from './ranking-recorded-page.tsx';

interface Args { persona: AnswerPersona; visit: string; loading: boolean; locale: UiLocale }
function ModuleStory(args: Args) { return <RecordedRankingPage record={rankingRecord as AnswerRecord} {...args} />; }
const meta = {
  title: 'Realm/Ranking module recorded', component: ModuleStory,
  args: { persona: 'visitor', visit: 'visit-ranking-module', loading: false, locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
  parameters: { docs: { description: { component: 'Production ranking modules with captured interval, original Work credit and shared Realm frame reads. No constructed module state supplies row proof.' } } },
  render: (args, { globals }) => <ModuleStory {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof ModuleStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { value: 'phone' } };
export const PopulatedDesktop: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.findAllByRole('tab')).resolves.toHaveLength(3);
    await expect(canvas.queryByRole('status')).toBeNull();
  },
};
export const PopulatedPhone: Story = { ...PopulatedDesktop, globals: phone };
export const EmptyDesktop: Story = { args: { visit: 'visit-ranking-module-empty' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('heading', { name: 'Nothing here yet' })).resolves.toBeVisible(); } };
export const EmptyPhone: Story = { ...EmptyDesktop, globals: phone };
export const LoadingDesktop: Story = { args: { loading: true },
  async play({ canvasElement }) { await expect(canvasElement.querySelector('[aria-busy="true"]')).not.toBeNull(); } };
export const LoadingPhone: Story = { ...LoadingDesktop, globals: phone };
export const Stranger: Story = { ...PopulatedDesktop, args: { persona: 'stranger' } };
export const Member: Story = { ...PopulatedDesktop, args: { persona: 'member' } };
export const Owner: Story = { ...PopulatedDesktop, args: { persona: 'owner' } };
export const Moderator: Story = { ...PopulatedDesktop, args: { persona: 'moderator' } };
export const Operator: Story = { ...PopulatedDesktop, args: { persona: 'operator' } };
