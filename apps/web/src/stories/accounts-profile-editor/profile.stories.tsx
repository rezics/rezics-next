import * as profilePresentation from '../../settings/ports/profile-editor-view';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { AccountProfileEditor } from '../../accounts/profile-editor/editor';
import { AccountProfileView } from '../../accounts/profile-editor/page';
import type { Failure, ProfilePage } from '../../accounts/profile-editor/data';
import { createBrowserSettingsAmbient } from '../../settings/adapters/ambient';
import type { ProfileValues } from '../../settings/profile-data';

const profile: ProfileValues = {
  accountId: '00000000-0000-7000-8000-000000000002',
  kind: 'organization',
  displayName: 'Managed organization',
  biography: 'Organization profile',
  avatar: null,
  links: [],
  publicViews: { posts: false, reviews: true, collections: false, realms: false },
  speakersListed: false,
};
function Example({ failure, confirmation = false }: { failure?: Failure; confirmation?: boolean }) {
  const [editor] = useState(() => {
    const editor = new AccountProfileEditor(
      {
        ambient: createBrowserSettingsAmbient(),
        read: async () => {
          throw new Error('No native transport in this presentation fixture');
        },
        save: async () => {
          throw new Error('No native transport in this presentation fixture');
        },
      },
      failure ? null : profile,
    );
    if (confirmation) {
      editor.edit({ displayName: 'Updated organization' });
      void editor.submit('profile');
    }
    return editor;
  });
  const page: ProfilePage = failure
    ? { state: failure }
    : { state: 'ready', viewerId: '00000000-0000-7000-8000-000000000001', profile };
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <AccountProfileView
        presentation={profilePresentation}
        accountId={profile.accountId}
        editor={editor}
        page={page}
      />
    </div>
  );
}
const meta = {
  title: 'Pages/Account/Profile editor',
  id: 'accounts-profile-editor',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Presentation fixtures for the account-specific editor. Confirmation locks the visible draft. These fixtures supply no native authority or successful write transport; integration acceptance and later Web visual review remain required.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Organization: Story = {};
export const Confirmation: Story = { args: { confirmation: true } };
export const Denied: Story = { args: { failure: 'denied' } };
export const Missing: Story = { args: { failure: 'missing' } };
export const Unavailable: Story = { args: { failure: 'unavailable' } };
