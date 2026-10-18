import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { resourceHref } from '../address/path.ts';
import { RelationshipControl } from '../relationships/control.tsx';
import { attributed } from '../rights-mark/fixtures.ts';
import Link from '../shell/localized-link.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { citationNames, citedStatements, importedSourceStatements, predicateLabels, projectionFor } from './fixtures.ts';
import { EntityHeader, SubjectDescription } from './header.tsx';
import { copyOf } from './messages.ts';
import { StatementSourcesView } from './sources.tsx';
import { standaloneHrefFor } from './route.ts';
import { StatementsView } from './views.tsx';

// Contract-built states. Real endpoint replay and screenshots belong to the wave prove phase.
const subject = projectionFor({ base: 'resource', types: ['https://schema.org/Organization'], name: 'Example Studio' });
const target = subject.target.resource;
const here = resourceHref('/e/', target);
const sourcePage = { ...importedSourceStatements(), factObligations: attributed, nextCursor: 'facts/+==' };
const hrefFor = standaloneHrefFor({}, here);

function Detail({ locale = 'en', long = false, unavailable = false, claims }: {
  locale?: UiLocale; long?: boolean; unavailable?: boolean; claims?: 'recorded' | 'withheld';
}) {
  const t = copyOf(locale);
  const page = claims ? { ...citedStatements(claims === 'withheld'), factObligations: attributed } : sourcePage;
  const names = claims ? citationNames : new Map();
  return <div className="mx-auto grid max-w-4xl gap-7 px-4 py-6">
    <EntityHeader summary={subject.summary as Extract<typeof subject.summary, { status: 'available' }>}
      registry={subject.registry} locale={locale} t={t}
      primary={<Link href="#related" className="rounded-sm text-primary underline underline-offset-4">{t.relations}</Link>}
      actions={<RelationshipControl target={target} kind="organization" name="Example Studio" locale={locale}
        signedIn={false} signInHref="/auth/start" reports={[{ target, kind: 'page' }]} />} />
    {long ? <SubjectDescription locale={locale}><p lang="en">{'The studio makes stories for readers around the world. '.repeat(90)}</p></SubjectDescription> : null}
    <StatementsView page={unavailable ? { ok: false, failure: 'unavailable' } : { ok: true, data: page }}
      names={names} ownName="Example Studio" labels={predicateLabels} cursor={undefined}
      hrefFor={hrefFor} locale={locale} t={t} messages={workMessages[locale]} pageEndSources />
    <section id="related" className="grid gap-2"><h2 className="font-semibold">{t.relations}</h2><p>Example series</p></section>
    <section id="discussion" className="grid gap-2"><h2 className="font-semibold">{t.discussion}</h2><p>{workMessages[locale].noDiscussionGlobal}</p></section>
    <StatementSourcesView page={unavailable ? { ok: false, failure: 'unavailable' } : { ok: true, data: page }}
      labels={predicateLabels} names={names} hrefFor={hrefFor} locale={locale} t={t} />
  </div>;
}

const meta = { title: 'Entity page/Complete detail', component: Detail } satisfies Meta<typeof Detail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SourcesAtPageEnd: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Example Studio' })).toBeVisible();
    const sources = canvas.getByRole('region', { name: 'Sources, licences and evidence' });
    await expect(within(sources).getByRole('link', { name: 'Evidence 1' })).toHaveAttribute('href',
      'https://example.test/organizations/studio-42/revisions/3');
    await expect(sources.compareDocumentPosition(canvas.getByRole('heading', { name: 'Discussion' })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      `/en${hrefFor({ kind: 'continue', section: 'statements', cursor: sourcePage.nextCursor })}`);
  },
};

export const MenuKeyboard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link', { name: 'Report this page' })).toBeNull();
    const trigger = canvas.getByRole('button', { name: 'More actions · Example Studio' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const item = await within(document.body).findByRole('menuitem', { name: 'Report this page' });
    const href = new URL(item.getAttribute('href')!, window.location.origin);
    await expect(href.searchParams.get('target')).toBe(target);
    await expect(href.searchParams.has('realm')).toBe(false);
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveFocus();
  },
};

export const LongDescriptionPhone: Story = {
  args: { long: true }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'More actions · Example Studio' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Show more' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await expect(canvas.getByRole('button', { name: 'Show less' })).toBeVisible();
  },
};

export const SourcesPhone: Story = { ...SourcesAtPageEnd, globals: { viewport: { value: 'phone' } } };
export const FactsUnavailable: Story = {
  args: { unavailable: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Example series')).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Sources, licences and evidence' })).toBeNull();
  },
};

export const ClaimCitations: Story = {
  args: { claims: 'recorded' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const sources = canvas.getByRole('region', { name: 'Sources, licences and evidence' });
    const footer = within(sources);
    await expect(footer.getByText('Example Studio', { exact: true })).toBeVisible();
    const first = footer.getByText('24', { exact: true }).closest('li')!;
    const second = footer.getByText('31', { exact: true }).closest('li')!;
    await expect(within(first).getByText('Annual report 1997')).toBeVisible();
    await expect(within(first).queryByText('Annual report 2001')).toBeNull();
    await expect(within(second).getByText('Annual report 2001')).toBeVisible();
    await expect(within(second).getByRole('link', { name: 'Evidence 1' })).toHaveAttribute('href',
      'https://example.test/studio/annual-report/2001');
    await expect(footer.getByText('Evidence reference')).toBeVisible();
    await expect(footer.getByText('Source fingerprint (SHA-256)')).toBeVisible();
    await expect(footer.getByText('ByteRangeSelector')).toBeVisible();
    await expect(sources.querySelector('blockquote')).toHaveTextContent('The studio employed 24 people in 1997.');
    await expect(footer.getByText('No evidence is recorded for this revision.')).toBeVisible();
    const evidence = citedStatements().groups[1]!.items[0]!;
    await expect(footer.getByText(evidence.sources[0]!, { exact: true })).toBeVisible();
    await expect(sources.querySelector(`a[href="${evidence.sources[0]}"]`)).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
  },
};

export const ClaimCitationsPhone: Story = { ...ClaimCitations, globals: { viewport: { value: 'phone' } } };

export const WithheldQuotation: Story = {
  args: { claims: 'withheld' },
  async play({ canvasElement }) {
    const sources = within(canvasElement).getByRole('region', { name: 'Sources, licences and evidence' });
    await expect(within(sources).getByText('The quoted passage is not available. Its source is still recorded.')).toBeVisible();
    await expect(sources.querySelector('blockquote')).toBeNull();
    await expect(within(sources).queryByText('The studio employed 24 people in 1997.')).toBeNull();
    await expect(within(sources).getByText('ByteRangeSelector')).toBeVisible();
    await expect(within(sources).getByText('Source fingerprint (SHA-256)')).toBeVisible();
  },
};
