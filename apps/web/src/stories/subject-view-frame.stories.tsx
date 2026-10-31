import type { Meta, StoryObj } from '@storybook/react-vite';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { getLocale } from '../paraglide/runtime';
import recordedPage from '../kernel/recorded/subject-page.json';
import { continuationSubject } from '../kernel/fake/view-continuation';
import { subjectHref } from '../subject/subject-href';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Subjects/Subject views',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Details: Story = {
  name: 'Details',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`${pagePaths.subject}/details`} />,
};

export const Relations: Story = {
  name: 'Relations',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`${pagePaths.subject}/relations`} />,
};

export const LargeData: Story = {
  name: 'Many editions',
  play: pageReady,
  render: () => (
    <PageStory visitor="Signed In" path={subjectHref(continuationSubject, 'en').href.replace(/^\/en/, '')} />
  ),
};

// Preserve the native recording's missing document/read results, including its unavailable summary.
export const Unavailable: Story = {
  name: 'Recorded summary unavailable',
  play: pageReady,
  render: () => {
    const page = recordedPage as unknown as SubjectPageData;
    return (
      <PatternStory visitor="Signed Out" path={pagePaths.subject}>
        <AppShell>
          <SubjectPage
            page={page}
            locale={getLocale()}
            messages={subjectPageMessages()}
            tabs={subjectTabs(page)}
            tabLabels={viewTabLabels()}
          />
        </AppShell>
      </PatternStory>
    );
  },
};
