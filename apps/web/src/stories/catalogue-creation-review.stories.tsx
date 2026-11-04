import type { Meta, StoryObj } from '@storybook/react-vite';
import { bundledRelease } from '@rezics/definitions/bundled';
import { StatementSummary } from '../features/catalogue/statement-summary';
import { CatalogueFileStatementSummary } from '../features/catalogue/catalogue-file-create-review';
import { catalogueFileCreateTypes } from '../features/catalogue/catalogue-file-create';
import { getLocale } from '../paraglide/runtime.js';

function CreationReview({ fileNotices = false }: { fileNotices?: boolean }) {
  const locale = getLocale();
  const type = catalogueFileCreateTypes(bundledRelease, locale)[0]!.id;
  const read = { release: bundledRelease, source: null, public: { subject: { type }, related: {} } };
  return (
    <article className="mx-auto max-w-3xl space-y-6 p-4">
      {fileNotices
        ? bundledRelease.types[type]!.properties.map((id) => (
            <CatalogueFileStatementSummary
              key={id}
              locale={locale}
              read={read}
              statement={{
                property: { id },
                value: { type: 'somevalue' },
                references: [],
                rank: 'normal',
              }}
            />
          ))
        : (['normal', 'preferred', 'deprecated'] as const).map((rank) => (
            <StatementSummary
              key={rank}
              locale={locale}
              read={read}
              statement={{
                property: { id: 'schema:name' },
                value: { type: 'value', content: 'Retained catalogue fact' },
                rank,
                qualifiers: [{ property: { id: 'schema:name' }, value: { type: 'somevalue' } }],
                references: [
                  { parts: [{ property: { id: 'schema:name' }, value: { type: 'novalue' } }] },
                  { parts: [] },
                ],
              }}
            />
          ))}
    </article>
  );
}

const meta = {
  title: 'Pages/Catalogue/Creation review',
  component: CreationReview,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof CreationReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllRanksAndOrderedEvidence: Story = {};
export const FileProfileNotices: Story = { args: { fileNotices: true } };
