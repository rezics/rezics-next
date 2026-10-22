import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { resourceHref } from '../address/path.ts';
import { work } from '../work-page/fixtures.ts';
import { messages } from '../work-page/messages.ts';
import { WorkFactsView, WorkSources } from '../work-page/work-sources.tsx';
import { predicateLabels, retainedSourceStatements } from './fixtures.ts';
import { copyOf } from './messages.ts';
import { standaloneHrefFor } from './route.ts';
import { StatementSourcesView } from './sources.tsx';
import { StatementsView } from './views.tsx';

// Contract states, paired with the actual composed Source-owner regression; not recorded HTTP answers.
const page = retainedSourceStatements();
const hrefFor = standaloneHrefFor({}, resourceHref('/e/', page.resource));
function Detail({ host = 'entity' }: { host?: 'entity' | 'work' }) {
  const facts = { page: { ok: true as const, data: page }, labels: predicateLabels, names: new Map(),
    ownName: 'Example Studio', hrefFor, cursor: undefined, locale: 'en' as const, t: copyOf('en'), messages: messages.en };
  return <div className="mx-auto grid max-w-4xl gap-7 px-4 py-6"><main className="grid min-w-0 gap-7">
    <h1 className="font-semibold text-2xl">Example Studio</h1>
    {host === 'work' ? <WorkFactsView {...facts} /> : <StatementsView {...facts} pageEndSources />}
    <section><h2 className="font-semibold">Discussion</h2><p>No discussion yet.</p></section></main>
    {host === 'work' ? <WorkSources work={work} locale="en" messages={messages.en} statements={facts.page}
      labels={predicateLabels} /> : <StatementSourcesView page={facts.page} labels={predicateLabels}
      hrefFor={hrefFor} locale="en" t={copyOf('en')} />}
  </div>;
}
async function inspect(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const footer = canvas.getByRole('contentinfo', { name: 'Sources and licenses' });
  const disclosure = within(footer).queryByText(messages.en.fieldEvidence, { selector: 'summary' });
  if (disclosure) await userEvent.click(disclosure);
  await expect(within(footer).getByText('1997', { exact: true })).toBeVisible();
  const citations = footer.querySelectorAll<HTMLElement>('[data-retained-source-citation]');
  await expect(citations).toHaveLength(2);
  await expect(within(citations[0]!).getByRole('link', { name: 'Example Studio registry' })).toHaveAttribute('href',
    'https://example.test/organizations/studio-42/revisions/3');
  await expect(within(citations[0]!).getByText('Example Studio was founded in 1997.')).toBeVisible();
  await expect(within(citations[1]!).getByText(copyOf('en').quotationWithheld)).toBeVisible();
  await expect(within(citations[1]!).queryByText('Example Studio was founded in 1997.')).toBeNull();
  await expect(citations[0]!.textContent).toContain('/organization/founded');
  await expect(citations[1]!.textContent).toContain('/history/0/year');
  await expect(footer.compareDocumentPosition(canvas.getByRole('heading', { name: 'Discussion' }))
    & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  citations[0]!.scrollIntoView({ block: 'start' });
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}
const meta = { title: 'Entity page/Retained Source citations', component: Detail } satisfies Meta<typeof Detail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Entity: Story = { play: ({ canvasElement }) => inspect(canvasElement) };
export const EntityPhone: Story = { ...Entity, globals: { viewport: { value: 'phone' } } };
export const Work: Story = { args: { host: 'work' }, play: Entity.play };
export const WorkPhone: Story = { ...Work, globals: { viewport: { value: 'phone' } } };
