import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { PageData } from '../features/pages/data';
import { TypeList } from '../features/pages/type-list';
import { subjectPageMessages } from '../features/pages/route-support';
import { catalogueExample, catalogueIds } from '../kernel/fake/catalogue-list-context';
import { getLocale } from '../paraglide/runtime';
import { PatternStory } from './page';

const document: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'TypeList',
      props: {
        id: 'works',
        title: { en: 'The Crossing' },
        types: ['schema:Book', 'schema:Movie'],
        sort: 'name',
        limit: 12,
      },
    },
  ],
};

function CatalogueStory({ state = 'compare' }: { state?: 'compare' | 'unavailable' | 'concealed' | 'continued' }) {
  const locale = getLocale();
  const continuation = state === 'continued' ? { node: 'works', cursor: 'source-page-two' } : undefined;
  const plan = planReads(platformRegistry, document, { subject: null, ...(continuation ? { continuation } : {}) });
  const book = catalogueExample();
  const rows =
    state === 'concealed'
      ? [
          {
            ...book,
            catalogueContext: {
              version: 1,
              subject: book.id,
              observation: 'concealed-example',
              target: null,
              state: 'withheld',
            },
          },
        ]
      : state === 'unavailable'
        ? [{ ...book, catalogueContext: undefined }]
        : state === 'continued'
          ? [catalogueExample(true)]
          : [book, catalogueExample(true)];
  return (
    <PatternStory>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <PageData
          locale={locale}
          subject={null}
          document={document}
          reads={{
            [plan.nodes.works!]: {
              status: 200,
              body: { subjects: rows, next: state === 'continued' ? null : 'source-page-two' },
            },
          }}
          context={{
            id: catalogueIds.realm,
            population: { kind: 'realm', id: catalogueIds.realm, title: 'Public Realm' },
          }}
          listTarget={{ subject: catalogueIds.book, realm: catalogueIds.realm }}
          fullList={state === 'continued' ? 'works' : undefined}
          {...(continuation ? { continuation, listCursor: continuation.cursor } : {})}
          messages={subjectPageMessages(locale)}
        >
          <TypeList {...document.content[0]!.props} />
        </PageData>
      </main>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Public list comparison',
  component: CatalogueStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Authored examples for the reserved catalogueContext v1 consumer; native producer activation is pending. Shared locale and theme controls apply.',
      },
    },
  },
} satisfies Meta<typeof CatalogueStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CompareHomonyms: Story = {
  args: { state: 'compare' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findAllByText('Akira Mori');
    await view.findAllByText('Aki Mori');
    for (const link of view.getAllByRole('link').filter((link) => link.getAttribute('target') === '_blank'))
      await expect(link.getAttribute('href')).toContain(`realm=${catalogueIds.realm}`);
  },
};
export const UnavailableContext: Story = { args: { state: 'unavailable' } };
export const ConcealedTarget: Story = { args: { state: 'concealed' } };
export const ScopedContinuation: Story = { args: { state: 'continued' } };
