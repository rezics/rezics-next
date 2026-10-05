import { direction } from '@rezics/main/language';
import { localizedPath } from '../../i18n/locale.ts';
import { addressPath, resourceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { servedTypes } from '../catalogue/type-fixtures.ts';
import { relations as relationsPage, summary } from '../work-levels/fixtures.ts';
import * as fixture from '../work-page/fixtures.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { TargetRatingsRegion } from '../work-page/ratings.tsx';
import { EntityHeader } from './header.tsx';
import { drawnSections } from './views.tsx';
import { copyOf } from './messages.ts';
import { DiscussionView, RelationsView, StatementsView } from './views.tsx';
import { appearances, baseSections, componentStatements, noStatements, predicateLabels, projectionFor, statements } from './fixtures.ts';
import { standaloneHrefFor } from './route.ts';
import type { TargetBase } from './types.ts';

// One page per resource, any base: the stories draw the header and each section from typed Main responses, and the
// matrix fails when a type the registry knows, or does not, is given a book's controls.

const hrefFor = standaloneHrefFor({}, resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d'));
const character = projectionFor({ base: 'resource', types: ['https://rezics.com/vocab/Character'], name: 'Kirito' });
const common = (locale: UiLocale) => ({ locale, t: copyOf(locale), messages: workMessages[locale], hrefFor });

function Page({ locale = 'en', children }: { locale?: UiLocale; children: React.ReactNode }) {
  return <div className="mx-auto grid max-w-4xl gap-10 px-4 py-6">
    <EntityHeader summary={character.summary as never} registry={character.registry} locale={locale} t={copyOf(locale)} />
    {children}
  </div>;
}

const meta = { title: 'Entity page/Sections', component: Page, args: { children: null } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const statementNames = new Map([[`https://rezics.com/id/c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c`,
  summary('https://rezics.com/id/c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c', 'Aincrad guild', 'en', 'resource')]]);

export const Statements: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><StatementsView page={{ ok: true, data: statements('next') }} labels={predicateLabels} ownName="Kirito" names={statementNames}
      cursor={undefined} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Kirito');
    await expect(canvas.getByText('Character')).toBeVisible();
    // A right-to-left value keeps its own direction inside the left-to-right page.
    await expect(canvas.getByText('الشبح الأسود')).toHaveAttribute('dir', 'auto');
    await expect(canvas.getByRole('link', { name: 'Aincrad guild' })).toHaveAttribute('href',
      localizedPath(resourceHref('/e/', 'c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c'), 'en'));
    await expect(canvas.getByText('Unknown value')).toBeVisible();
    // The name the heading already shows is not repeated, a predicate without a label is gathered under "Other facts", and
    // no group draws an empty heading.
    await expect(canvas.getAllByText('Kirito')).toHaveLength(1);
    await expect(canvas.getByText('キリト')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 3, name: 'Other facts' })).toBeVisible();
    for (const heading of canvas.getAllByRole('heading', { level: 3 })) await expect(heading).not.toBeEmptyDOMElement();
    // The list continues by Main's cursor, on the same address.
    await expect(canvas.getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}?statements=next#statements`, 'en'));
  },
};

export const DefinitionLabels: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: statements() }} names={statementNames} cursor={undefined}
    labels={new Map([['https://schema.org/alternateName', { value: '別名', language: 'ja', direction: direction('ja', '別名') }]])}
    {...common('ja')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('別名')).toHaveAttribute('lang', 'ja');
    await expect(canvas.queryByText('alternateName')).toBeNull();
    await expect(canvas.queryByText('memberOf')).toBeNull();
    await expect(canvas.getByText('Aincrad guild')).toBeVisible();
  },
};

export const ComponentProperties: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: componentStatements }} names={new Map()} cursor={undefined}
    {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const name = within(canvasElement).getByText('معرض الهولوغرام');
    // The owner's text keeps its own language and direction rather than appearing as a serialized record.
    await expect(name).toHaveAttribute('dir', 'rtl');
    await expect(name).toHaveAttribute('lang', 'ar');
  },
};

export const StatementsEmpty: Story = {
  render: () => <Page><StatementsView page={{ ok: true, data: noStatements }} names={new Map()} cursor={undefined}
    {...common('en')} /></Page>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('No statements yet')).toBeVisible();
  },
};

export const StatementsFailedOnAStaleCursor: Story = {
  render: () => <Page><StatementsView page={{ ok: false, failure: 'moved' }} names={new Map()} cursor="stale"
    {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Statements could not be loaded.');
    // A stale cursor restarts from the first page rather than retrying the same one.
    await expect(canvas.getByRole('link', { name: 'First page' })).toHaveAttribute('href',
      localizedPath(`${resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')}#statements`, 'en'));
  },
};

export const Relations: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><RelationsView page={relationsPage} cursor={undefined} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Relations' })).toBeVisible();
    // A counterpart that is a Work links to its own host.
    await expect(canvas.getAllByRole('link').some(link => addressPath(link.getAttribute('href') ?? '')?.lookup.scope === 'work')).toBe(true);
  },
};

export const Appearances: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><RelationsView page={{ ok: true, data: appearances() }} cursor={undefined} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // Each appearance reads as its Work with the role it had there, and the credited name where one is recorded.
    const rows = canvas.getAllByRole('listitem').filter(item => item.textContent?.includes('A Certain'));
    await expect(rows).toHaveLength(2);
    await expect(rows[0]).toHaveTextContent(/A Certain Magical Index\s*·\s*RoleSupporting character\s*as Mikoto/);
    await expect(rows[1]).toHaveTextContent(/A Certain Scientific Railgun\s*·\s*RoleLead character/);
    await expect(canvasElement.querySelector('[data-role-chip]')).toBeNull();
  },
};

export const RelationsFailed: Story = {
  render: () => <Page><RelationsView page={{ ok: false, failure: 'unavailable' }} cursor={undefined} {...common('en')} /></Page>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Relations could not be loaded.');
  },
};

export const Discussion: Story = {
  render: (_args, context) => {
    const locale = context.globals.locale as UiLocale;
    return <Page locale={locale}><DiscussionView page={fixture.discussion} cursor={undefined}
      resource="https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d" subject="character" signedIn
      realms={new Map()} {...common(locale)} /></Page>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // The same action on every page: it names the resource's kind and leads to the composer with it as the target.
    const discuss = canvas.getAllByRole('link', { name: 'Discuss this character' })[0]!;
    await expect(discuss).toHaveAttribute('href', '/en/submit?target=0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d');
    await expect(canvas.getAllByRole('article').length).toBeGreaterThan(0);
  },
};

export const DiscussionEmptyAnonymous: Story = {
  render: () => <Page><DiscussionView page={fixture.noDiscussion} cursor={undefined}
    resource="https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d" subject="release" signedIn={false}
    realms={new Map()} {...common('en')} /></Page>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // A signed-out reader is sent to sign in and back to the composer.
    await expect(canvas.getAllByRole('link', { name: 'Discuss this release' })[0]).toHaveAttribute('href',
      expect.stringContaining('/auth/start?next='));
  },
};

export const Ratings: Story = {
  render: () => <Page><TargetRatingsRegion ratings={fixture.globalRatings} subject={copyOf('en').ratingsFor({ subject: 'release' })}
    none={copyOf('en').noRatings} locale="en" messages={workMessages.en} /></Page>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Ratings for this release')).toBeVisible();
  },
};

/** Every registry entry on its base: the header says what it is and the page offers no book controls unless it is a book. */
const bases = Object.keys(baseSections) as TargetBase[];
const registryBase = (base: TargetBase) => base === 'work' || base === 'resource' || base === 'projection' ? base : 'record';
const entries = bases.flatMap(base => servedTypes.types.filter(entry => entry.base === registryBase(base))
  .map(entry => ({ base, entry })));

export const BaseByPresentationMatrix: Story = {
  render: () => <div className="grid gap-6 p-4">{entries.map(({ base, entry }) => {
    const page = projectionFor({ base, types: [entry.type], name: `${base} ${entry.presentation}` });
    return <section key={`${base}-${entry.type}`} data-matrix={`${base}:${entry.type}`} className="grid gap-2">
      <EntityHeader summary={page.summary as never} registry={page.registry} locale="en" t={copyOf('en')} />
      <ul aria-label="Sections drawn">{page.sections.filter(section => drawnSections.includes(section.id))
        .map(section => <li key={section.id}>{section.id}</li>)}</ul>
    </section>;
  })}</div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelectorAll('[data-matrix]').length).toBe(entries.length);
    // No type, known or not, draws a book's controls on the generic page.
    await expect(canvas.queryAllByRole('button', { name: /^(read|start reading|continue reading)$/i })).toHaveLength(0);
    await expect(canvas.queryAllByRole('link', { name: /^(read|start reading|continue reading)$/i })).toHaveLength(0);
    // Contents, releases and credits belong to their own hosts; the generic page never draws them.
    for (const list of canvas.getAllByRole('list', { name: 'Sections drawn' })) {
      for (const item of within(list).queryAllByRole('listitem')) {
        await expect(['statements', 'relations', 'ratings', 'reviews', 'discussion']).toContain(item.textContent);
      }
    }
  },
};
