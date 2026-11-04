import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ShelfEntries, LabelShelfEntries } from '../library/shelf-view';
import { shelfContextExamples, shelfExampleId } from '../library/shelf-work-context/examples';
import { prepareShelfWorkContext } from '../library/shelf-work-context/context';
import { contextExampleRelease } from '../library/shelf-work-context/examples';
import type { ShelfLayout } from '../library/shelf-params';
import { getLocale } from '../paraglide/runtime.js';
import { Button } from '@rezics/ui/shadcn/button';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Library/Identifying work context',
  parameters: {
    layout: 'fullscreen',
    admitted: ['personal_library', 'reading_progress', 'library_label.assignment_list'],
    viewport: { options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
    } },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// These examples are illustrative and have not been visually inspected. Locale/theme globals remain available.
function Examples({ layout, labelShelf = false }: { layout: ShelfLayout; labelShelf?: boolean }) {
  const locale = getLocale();
  const [replacement, setReplacement] = useState(false);
  const entries = replacement ? [] : shelfContextExamples(locale);
  const label = { id: shelfExampleId(800), name: 'Home adaptations' };
  return <PatternStory visitor="Signed In" path={`/library?layout=${layout}${labelShelf ? `&label=${label.id}` : ''}`}>
    <section className="mx-auto max-w-6xl space-y-4 p-4">
      <Button onClick={() => setReplacement(true)}>Replace reader</Button>
      {labelShelf ? <LabelShelfEntries label={label} locale={locale} layout={layout} size="m" csrfToken={null}
        isCurrent={() => !replacement} entries={entries.map((entry, index) => {
          const assignment = { ...entry, id: shelfExampleId(900 + index), labelId: label.id };
          return { ...assignment, workContext: prepareShelfWorkContext(assignment, contextExampleRelease, locale) };
        })} /> : <ShelfEntries entries={entries} locale={locale} layout={layout} size="m" isCurrent={() => !replacement} />}
    </section>
  </PatternStory>;
}
export const List: Story = { render: () => <Examples layout="list" /> };
export const Grid: Story = { render: () => <Examples layout="grid" /> };
export const Table: Story = { render: () => <Examples layout="table" /> };
export const LabelShelf: Story = { render: () => <Examples layout="table" labelShelf /> };
