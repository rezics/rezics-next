import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { literaryGrainExample } from '../features/catalogue/literary-reader/examples';
import { literaryEssentialFields } from '../features/catalogue/literary-reader/presentation';
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
function LiteraryOverviewStory({
  type = 'schema:Book',
}: {
  type?: 'schema:Book' | 'schema:BookSeries' | 'bf:Instance';
}) {
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
        rezics: { release: read.subject.release, revision: read.subject.revision },
      },
    ];
    if (type !== 'schema:Book') {
      const example = literaryGrainExample(type);
      const original = structuredClone(read.subject);
      read.subject = {
        ...original,
        ...example.work,
        descriptions: {
          en:
            type === 'schema:BookSeries'
              ? 'Stories of a changing port town, told through the lives of its readers, boat builders and visiting families. Each book retains its own place in the series.'
              : 'An illustrated edition of the harbour novel. Publication and translation details belong to this edition; the original work remains a separate reading.',
        },
      };
      read.related = example.related;
      if (read.summary) {
        read.summary.id = example.work.id;
        read.summary.type = type;
        read.summary.types = [type, ...(example.definitions.types[type]?.bases ?? [])];
        read.summary.label = { value: example.work.labels.en!, language: 'en' };
      }
      page.subject = example.work.id;
      page.context = example.context;
      page.catalogue = {
        state: 'released',
        type,
        definitions: example.definitions,
        digest: example.digest,
        directions: example.directions,
      };
      const document: CompositionDocument = {
        root: { props: {} },
        content: [
          { type: 'SubjectHeader', props: { id: 'subject-header' } },
          { type: 'Summary', props: { id: 'summary' } },
          {
            type: 'Statements',
            props: {
              id: 'statements',
              properties: literaryEssentialFields.filter((property) =>
                example.definitions.types[type]!.properties.includes(property),
              ),
            },
          },
          ...example.windows.map((window) => ({
            type: 'SubjectList',
            props: { id: window.node, property: window.property, limit: window.limit },
          })),
        ],
      };
      page.document = document as typeof page.document;
      page.views =
        type === 'schema:BookSeries' ? ['overview', 'contents', 'relations', 'details'] : ['overview', 'details'];
      const plan = planReads(platformRegistry, document, {
        subject: page.subject,
        account: null,
        context: example.context,
      });
      page.reads = {};
      for (const [key, planned] of Object.entries(plan.reads)) {
        const window = example.windows.find(
          (window) =>
            (planned.kind === 'links' || planned.kind === 'relations') && window.property === planned.property,
        );
        page.reads[key] =
          planned.kind === 'subject'
            ? { status: 200, body: read }
            : window
              ? { status: 200, body: { links: window.rows, next: window.next, freshness: { caught_up: true } } }
              : { status: 200, body: { relations: [] } };
      }
    }
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

export const Series: Story = { render: () => <LiteraryOverviewStory type="schema:BookSeries" /> };
export const Edition: Story = { render: () => <LiteraryOverviewStory type="bf:Instance" /> };
