import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { loadRoutePage, RoutePage } from '../features/pages/route';
import { createRecordedKernelFetch, type KernelRecording } from '../kernel/fake';
import homePageRecording from '../kernel/recorded/home-page.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady } from './page';

const client = createKernelClient('http://kernel.local', {
  fetch: createRecordedKernelFetch({ 'home-page': homePageRecording as KernelRecording }),
});
const loaded = await loadRoutePage(client, '/');
if (loaded.kind !== 'page') throw new Error('The recorded home page did not load.');

function RecordedHome() {
  return (
    <RoutePage
      page={loaded.page}
      locale={getLocale()}
      heading={m.home_heading()}
      messages={{
        unknown: m.subject_value_unknown(),
        none: m.subject_value_none(),
        unlabelled: m.subject_value_unlabelled(),
        sources: m.subject_sources(),
        aliases: m.subject_aliases(),
        search: m.search_submit(),
      }}
    />
  );
}

const meta = { title: 'Pages/Home', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed In">
      <RecordedHome />
    </PageStory>
  ),
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed Out">
      <RecordedHome />
    </PageStory>
  ),
};
