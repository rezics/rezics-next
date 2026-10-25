import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { loadSubjectPage, SubjectPage } from '../features/pages/subject';
import { createRecordedKernelFetch } from '../kernel/fake';
import missingSubjectPage from '../kernel/recorded/missing-subject-page.json';
import subjectPage from '../kernel/recorded/subject-page.json';
import subjectRecording from '../kernel/recorded/subject.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady } from './page';

const client = createKernelClient('http://kernel.local', {
  fetch: createRecordedKernelFetch({
    subject: subjectRecording,
    'subject-page': subjectPage,
    'missing-subject-page': missingSubjectPage,
  }),
});
const loaded = await loadSubjectPage(client, subjectRecording.subject.id);
if (loaded.kind !== 'page') throw new Error('The recorded subject page did not load.');
const page = loaded.page;

function RecordedSubject() {
  return (
    <article>
      <SubjectPage
        page={page}
        locale={getLocale()}
        messages={{
          unknown: m.subject_value_unknown(),
          none: m.subject_value_none(),
          unlabelled: m.subject_value_unlabelled(),
          sources: m.subject_sources(),
          aliases: m.subject_aliases(),
        }}
      />
    </article>
  );
}

const meta = { title: 'Pages/Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed In">
      <RecordedSubject />
    </PageStory>
  ),
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed Out">
      <RecordedSubject />
    </PageStory>
  ),
};
