import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { targetKey } from '../address/path.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { ZoneEditorFrame } from './frame.tsx';
import { messages } from './messages.ts';

const zoneId = '00000000-0000-4000-8000-000000000521';
const spaceId = '00000000-0000-4000-8000-000000000522';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000523';
const editorPath = `/manage/z/${zoneId}`;
const returnAddress = `${targetKey(spaceId)}-Harbor-notes`;
const agent = { iri: actor, label: 'Harbor editor', handle: null, kind: 'person' as const, path: 'direct-principal' as const };

function AddressFrame({ retired = false, verifiedReturnAddress = targetKey(spaceId) }: {
  retired?: boolean; verifiedReturnAddress?: string;
}) {
  return <ZoneEditorFrame name="Harbor notes" editorPath={editorPath} agent={agent} locale="en"
    manageMessages={manageMessages} sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
    sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm} sectionTheme={messages.en.sectionTheme}
    sectionLifecycle={messages.en.sectionLifecycle} lifecycleOnly={retired}
    lifecycleAddress={{ zoneId, spaceId, returnAddress: verifiedReturnAddress }}>
    <p>{retired ? messages.en.lifecycleStatusRetired : messages.en.lifecycleStatusActive}</p>
  </ZoneEditorFrame>;
}

const meta = {
  title: 'Zone editor/Management addresses',
  render: () => <AddressFrame />,
  parameters: { route: { pathname: `/en${editorPath}` }, viewport: { defaultViewport: 'responsive' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveUuidEditor: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Navigation' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Theme' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Status' })).toHaveAttribute('href',
      `/en${editorPath}/lifecycle?address=${encodeURIComponent(targetKey(spaceId))}`);
  },
};

export const RetiredStatusRetainsReturn: Story = {
  render: () => <AddressFrame retired />,
  parameters: { route: { pathname: `/en${editorPath}/lifecycle`, search: `address=${encodeURIComponent(returnAddress)}` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link', { name: 'Home' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Status' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Status' })).toHaveAttribute('href',
      `/en${editorPath}/lifecycle?address=${encodeURIComponent(returnAddress)}`);
  },
};

export const RetiredStatusRetainsVerifiedAlias: Story = {
  render: () => <AddressFrame retired verifiedReturnAddress="harbor" />,
  parameters: { route: { pathname: `/en${editorPath}/lifecycle`, search: 'address=harbor' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Status' })).toHaveAttribute('href',
      `/en${editorPath}/lifecycle?address=harbor`);
  },
};
