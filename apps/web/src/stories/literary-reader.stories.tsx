import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { SubjectPage, subjectBody, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory, pagePaths } from './page';
import recording from '../kernel/recorded/subject-page.json';
import recordedSubject from '../kernel/recorded/subject.json';

/** Supplied native response shape with a supplied cover; illustrative density, not new native evidence. */
function LiteraryOverviewStory() {
  const [page] = useState(() => {
    const page = structuredClone(recording) as unknown as SubjectPageData;
    const read = subjectBody(page)!;
    if (read.summary) read.summary.cover = structuredClone(recordedSubject.summary.cover) as typeof read.summary.cover;
    read.subject.aliases = { ...read.subject.aliases, en: ['The Little Prince', 'The prince from asteroid B 612'] };
    read.subject.statements['schema:wordCount'] = [
      {
        id: 'supplied-word-count',
        rank: 'normal',
        property: { id: 'schema:wordCount', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '+17000', unit: '1' } },
        qualifiers: [],
        references: [],
      },
    ];
    return page;
  });
  return (
    <PatternStory visitor="Signed Out" path={pagePaths.subject}>
      <AppShell>
        <SubjectPage
          page={page}
          locale={getLocale()}
          messages={subjectPageMessages()}
          tabs={subjectTabs(page)}
          tabLabels={viewTabLabels()}
          renderJsonLd={false}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Literary reader/Overview',
  id: 'pages-subjects-literary-work',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Book: Story = {
  render: () => <LiteraryOverviewStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'The Little Prince' });
    await expect(canvasElement.querySelector('[data-slot="subject-header"] [data-slot="cover"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-slot="literary-window"]')).toBeNull();
  },
};
