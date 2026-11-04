import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { bundledRelease } from '@rezics/definitions/bundled';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { LiteraryCreateReview } from '../features/catalogue/literary-create-review-view';
import type { LiteraryItem } from '../features/catalogue/literary-profile';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

function EvidenceReturn({ revised = false }: { revised?: boolean }) {
  const locale = getLocale();
  const o = { locale: locale as never };
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(
    revised ? 'https://example.org/revised-proposal' : 'https://example.org/original-proposal',
  );
  const item: LiteraryItem = {
    type: 'schema:Book',
    labels: {},
    statements: {
      'schema:url': [
        {
          property: { id: 'schema:url' },
          value: { type: 'value', content: value },
          rank: 'preferred',
          qualifiers: [{ property: { id: 'schema:name' }, value: { type: 'value', content: 'Original bibliography' } }],
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: {
                    type: 'value',
                    content:
                      'https://example.org/identical-looking-evidence-with-a-long-path/retained-in-its-original-group',
                  },
                },
                {
                  property: { id: 'schema:name' },
                  value: {
                    type: 'value',
                    content:
                      'https://example.org/identical-looking-evidence-with-a-long-path/retained-in-its-original-group',
                  },
                },
              ],
            },
            { parts: [] },
            { parts: [{ property: { id: 'schema:name' }, value: { type: 'somevalue' } }] },
          ],
        },
      ],
    },
  };
  return (
    <article className="mx-auto min-w-0 max-w-3xl space-y-6 p-4">
      <LiteraryCreateReview
        item={item}
        release={bundledRelease}
        locale={locale}
        stale={false}
        factId={() => 'original-literary-url'}
        onJump={() => field.current?.focus()}
      />
      <div className="min-w-0 space-y-3 rounded-xl border border-border p-4">
        <label htmlFor="original-literary-url">{m.correction_url({}, o)}</label>
        <Input
          ref={field}
          id="original-literary-url"
          type="url"
          value={value}
          className="min-h-11"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-11 whitespace-normal"
          onClick={() => document.querySelector<HTMLElement>('[data-literary-create-review] button')?.focus()}
        >
          {m.literary_review_title({}, o)}
        </Button>
      </div>
    </article>
  );
}

const meta = {
  title: 'Pages/Catalogue/Statement review consumers',
  component: EvidenceReturn,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof EvidenceReturn>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReferenceMeaningAndFieldReturn: Story = {};
export const RevisedProposal: Story = { args: { revised: true } };
