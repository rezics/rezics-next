import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/zone/list-attached-zones.json';
import { isUiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { signInPath } from '../auth/paths.ts';
import { messages } from './messages.ts';
import ja from './messages/ja.ts';
import { attachmentIdentity } from './zone-attachments-recorded-page.ts';
import { ZoneAttachmentsRecordedPage } from './zone-attachments-recorded-page.tsx';

const record = answers as AnswerRecord;
const meta = {
  title: 'Manage/Recorded attached Zones', component: ZoneAttachmentsRecordedPage,
  args: { record, persona: 'owner', visit: 'inventory', loading: false, locale: 'en' },
  globals: { viewport: { value: 'phone' } },
  render: (args, { globals }) => <ZoneAttachmentsRecordedPage {...args} locale={isUiLocale(globals.locale) ? globals.locale : args.locale} />,
} satisfies Meta<typeof ZoneAttachmentsRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];
const localeOf = ({ globals }: Context) => isUiLocale(globals.locale) ? globals.locale : 'en';
const text = (context: Context) => materializeData(localeOf(context) === 'ja' ? ja : messages, { locale: localeOf(context) });

async function identity(context: Context) {
  const canvas = within(context.canvasElement), persona = context.args.persona;
  const profile = record.personas[persona].find(sample => sample.label === 'session-4')!.answer as { displayName: string };
  await expect(canvas.findByText(profile.displayName, { exact: true })).resolves.toBeVisible();
  const header = record.personas[persona].find(sample => sample.label === 'frame-header-0')!.answer as { name: { value: string } };
  await expect(canvas.findByRole('heading', { level: 1, name: header.name.value })).resolves.toBeVisible();
}
async function populated(context: Context) {
  const canvas = within(context.canvasElement), t = text(context);
  const list = await canvas.findByRole('list', { name: t.zonesTitle });
  await identity(context);
  await expect(within(list).getAllByRole('listitem')).toHaveLength(24);
  for (const count of [48, 50]) {
    await userEvent.click(canvas.getByRole('button', { name: t.loadMore }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(count));
  }
  await expect(canvas.queryByRole('button', { name: t.loadMore })).toBeNull();
  const sample = record.personas[context.args.persona].find(item => item.label === `${context.args.visit}-0`)!;
  const page = sample.answer as { items: { name: string | null; address: { key: string; prefix: string } }[] };
  const item = page.items[0]!;
  await expect(within(within(list).getAllByRole('listitem')[0]!).getByRole('link', { name: t.zonesOpen({ zone: item.name ?? t.zonesNameFallback }) })).toHaveAttribute(
    'href', localizedPath(spaceHref(item.address.key, 'site'), localeOf(context)));
  await expect(canvas.getAllByRole('button', { name: t.zonesWithdraw })).toHaveLength(50);
}
async function concealed(context: Context) {
  const canvas = within(context.canvasElement), t = text(context);
  await expect(canvas.findByRole('heading', { name: t.missingTitle })).resolves.toBeVisible();
  await identity(context);
  await expect(canvas.queryByRole('list', { name: t.zonesTitle })).toBeNull();
  await expect(canvas.queryByRole('button', { name: t.loadMore })).toBeNull();
  await expect(context.canvasElement.querySelector('a[href*="/z/"]')).toBeNull();
  await expect(canvas.queryByRole('button', { name: t.zonesWithdraw })).toBeNull();
}

export const OwnerPhone: Story = { play: populated };
export const OwnerDesktop: Story = { play: populated, globals: { viewport: { value: 'desktop' } } };
export const ExactLiveMandate: Story = { args: { persona: 'operator' }, play: populated };
export const DelegatedModerator: Story = { args: { persona: 'moderator', visit: 'delegated' }, play: populated };
export const Stranger: Story = { args: { persona: 'stranger' }, play: concealed };
export const Member: Story = { args: { persona: 'member' }, play: concealed };
export const BareModerator: Story = { args: { persona: 'moderator' }, play: concealed };
export const BareOperator: Story = { args: { persona: 'operator', visit: 'bare' }, play: concealed };
export const RevokedRetainedCursor: Story = { args: { persona: 'moderator', visit: 'revoked' }, async play(context) {
  const canvas = within(context.canvasElement), t = text(context);
  await canvas.findByRole('list', { name: t.zonesTitle });
  await userEvent.click(canvas.getByRole('button', { name: t.loadMore }));
  await concealed(context);
} };
export const Loading: Story = { args: { loading: true }, async play(context) {
  await expect(within(context.canvasElement).findByRole('status')).resolves.toHaveAttribute('aria-busy', 'true');
} };
export const Visitor: Story = { args: { persona: 'visitor' }, async play(context) {
  const canvas = within(context.canvasElement), t = text(context), { realm } = attachmentIdentity(record, 'visitor');
  await expect(canvas.findByRole('link', { name: t.signInTitle })).resolves.toHaveAttribute('href',
    signInPath(localizedPath(`/manage/r/${realm}/zones`, localeOf(context))));
  await expect(canvas.queryByRole('list', { name: t.zonesTitle })).toBeNull();
} };
