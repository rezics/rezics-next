import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { loadSubjectPage } from '../features/pages/subject';
import { createRecordedKernelFetch } from '../kernel/fake';
import missingSubjectPage from '../kernel/recorded/missing-subject-page.json';
import subjectPage from '../kernel/recorded/subject-page.json';
import { NotFoundPage } from '../shell/shell';
import { PageStory, pageReady } from './page';

const missingId = '00000000-0000-4000-8000-000000000000';
const client = createKernelClient('http://kernel.local', {
  fetch: createRecordedKernelFetch({
    'subject-page': subjectPage,
    'missing-subject-page': missingSubjectPage,
  }),
});
const loaded = await loadSubjectPage(client, missingId);
if (loaded.kind !== 'missing') throw new Error('The recorded missing subject should be missing.');

const meta = { title: 'Pages/Missing Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed In">
      <NotFoundPage />
    </PageStory>
  ),
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed Out">
      <NotFoundPage />
    </PageStory>
  ),
};
