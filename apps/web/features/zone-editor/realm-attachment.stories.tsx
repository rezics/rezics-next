import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { copyOf } from './messages.ts';
import { RealmAttachmentEditor } from './realm-attachment.tsx';

const meta = { title: 'Zone editor/Realm attachment', component: RealmAttachmentEditor,
  args: {
    zoneId: '00000000-0000-4000-8000-000000000301',
    actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000302',
    copy: copyOf('en'),
    zoneHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000304',
    attachedName: null,
    signInHref: '/auth/start',
    startingNotice: 'limit',
  } } satisfies Meta<typeof RealmAttachmentEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The attach refusal when that community already has every site it can. */
export const AtTheAttachmentLimit: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This community is linked to the most sites it can be.');
    await expect(canvas.getByRole('button', { name: 'Attach' })).toBeVisible();
  },
};
