import { candidateContext } from '../subject/candidates';
import {
  mangaPublicCorrectionHref,
  mangaGlobalVisitHref,
  mangaObservedOrigin,
} from '../features/catalogue/manga-public-visit';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { PageStory } from './page';
import { MangaCorrections } from '../features/catalogue/manga-profile-corrections';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import {
  selectMangaStory,
  clearMangaStory,
  mangaVolumeId,
  mangaCreatorId,
  mangaVolumeCitation,
  type MangaScenario,
} from '../kernel/fake/catalogue-manga-profile';

// All plays authored UNRUN. These are supplied native-shaped response examples, not native proof.
const longLabel = 'Création et attribution intégrales — ' + 'BibliographieSansAbréviation'.repeat(12);
const longName = 'Mika Sora — ' + 'CompleteReleasedCreatorName'.repeat(14);
const longCredit = 'Nom intégral imprimé dans cette édition — ' + 'SignatureOriginale'.repeat(14);
const longCitation =
  'https://archive.example/volume/' + 'original-unabridged-record-'.repeat(18) + '?scan=A%2Fb#citation';
let fixture: ReturnType<typeof selectMangaStory>;

function supplyGroups() {
  const read = fixture.reads.get(mangaVolumeId)!;
  fixture.release.properties['schema:author']!.labels = { fr: longLabel };
  read.related[mangaCreatorId]!.labels = { fr: longName };
  const member = read.subject.statements['wdt:P179']![0]!;
  const author = structuredClone(member);
  author.id = '00000000-0000-4000-8000-00000000d191';
  author.property = { id: 'schema:author', data_type: 'wikibase-item' };
  author.value = { type: 'value', content: mangaCreatorId };
  author.qualifiers.push({
    property: { id: 'wdt:P1932', data_type: 'string' },
    value: { type: 'value', content: longCredit },
  });
  author.references = [
    {
      hash: 'complete-citation',
      parts: [
        { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: longCitation } },
        {
          property: { id: 'schema:name', data_type: 'monolingualtext' },
          value: { type: 'value', content: { text: '原本の完全な書誌', language: 'ja' } },
        },
      ],
    },
  ];
  read.subject.statements['schema:author'] = [author];
  read.subject.statements['wdt:P179'] = [
    member,
    ...(['somevalue', 'novalue'] as const).map((type, index) => ({
      ...structuredClone(member),
      id: `00000000-0000-4000-8000-00000000d19${index + 2}`,
      value: { type },
    })),
  ];
}
function CorrectionFamily({
  signedOut = false,
  rtl = false,
  origin = 'legacy',
}: {
  origin?: 'legacy' | 'global' | 'selected' | 'realm' | 'fresh';
  scenario?: MangaScenario;
  signedOut?: boolean;
  rtl?: boolean;
}) {
  const locale = getLocale();
  const read = fixture.reads.get(mangaVolumeId)!;
  const href = subjectHref({ id: mangaVolumeId, label: pickText(read.subject.labels, locale).text }, locale).href;
  const publicHref = origin === 'realm' ? `${href}?realm=00000000-0000-4000-8000-00000000d199` : href;
  const path =
    origin === 'legacy'
      ? `${href}/manga`
      : origin === 'fresh'
        ? mangaGlobalVisitHref(mangaVolumeId, locale, href)
        : mangaPublicCorrectionHref(
            `${href}/manga`,
            mangaObservedOrigin({
              subject: mangaVolumeId,
              type: 'schema:PublicationVolume',
              context: origin === 'selected' ? '00000000-0000-4000-8000-00000000d198' : candidateContext,
              ...(origin === 'realm' ? { realm: '00000000-0000-4000-8000-00000000d199' } : {}),
              returnHref: publicHref,
            }),
          );
  return (
    <div dir={rtl ? 'rtl' : undefined}>
      <PageStory visitor={signedOut ? 'Signed Out' : 'Signed In'} path={path} />
    </div>
  );
}
const meta = {
  title: 'Pages/Catalogue/Manga correction family',
  component: CorrectionFamily,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Actual correction route and whole-component independent mounts. Full supplied groups, native FactField controls and deliberate submission; phone390/desktop1440, locale/theme and RTL review. Every new assertion is UNRUN; geometry, native authorization and lifecycle acceptance remain deferred.',
      },
    },
  },
  beforeEach: ({ args }) => {
    fixture = selectMangaStory(args.scenario ?? 'ready', getLocale());
    supplyGroups();
    return () => clearMangaStory();
  },
} satisfies Meta<typeof CorrectionFamily>;
export default meta;
type Story = StoryObj<typeof meta>;
const options = () => ({ locale: getLocale() as never });
const name = (property: string) => pickText(fixture.release.properties[property]!.labels, getLocale()).text;
async function enabled(control: HTMLElement) {
  await waitFor(() => expect(control).toBeEnabled());
  return control;
}
function fallback(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole('heading', { level: 3, name: longLabel }).closest('section')!;
}
async function inspectGroups(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 3, name: longLabel });
  const author = fallback(canvasElement);
  await expect(within(author).getByRole('link', { name: longName })).toBeVisible();
  await expect(within(author).getByText(longCredit)).toBeVisible();
  const citation = within(author).getByRole('link', { name: longCitation });
  await expect(citation).toHaveAttribute('href', longCitation);
  await expect(within(author).getByText('原本の完全な書誌')).toHaveAttribute('lang', 'ja');
  await expect(author.querySelector('h3')).toHaveAttribute('lang', 'fr');
  await expect(author.querySelector('button, input, select, [data-slot="list-row-link"]')).toBeNull();
  const membership = canvas
    .getByRole('heading', { level: 2, name: m.manga_membership({}, options()) })
    .closest('section')!;
  await expect(within(membership).getByText(m.subject_value_unknown({}, options()))).toBeVisible();
  await expect(within(membership).getByText(m.subject_value_none({}, options()))).toBeVisible();
  const genre = canvas.getByRole('heading', { level: 3, name: name('schema:genre') }).closest('section')!;
  await expect(within(genre).getByText(m.facts_no_value({}, options()))).toBeVisible();
  await expect(
    canvas.getByRole('heading', { level: 2, name: m.facts_selection({ count: 0, limit: 12 }, options()) }),
  ).toBeVisible();
  await expect(canvas.getByRole('button', { name: m.facts_submit({}, options()) })).toBeDisabled();
  await expect(canvas.getByRole('button', { name: m.correction_reload({}, options()) })).toBeEnabled();
  const count = canvas.getByRole('heading', { level: 2, name: m.facts_selection({ count: 0, limit: 12 }, options()) });
  for (const control of count.parentElement!.querySelectorAll('button')) {
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      window.matchMedia('(min-width: 768px) and (pointer: fine)').matches ? 32 : 44,
    );
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  }
  for (const element of [author, count.parentElement!, ...author.querySelectorAll<HTMLElement>('h3, dt, dd, a')]) {
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    await expect(element.className).not.toMatch(/truncate|line-clamp/);
  }
  const titleLink = within(author).getByRole('link', { name: longName });
  titleLink.focus();
  await userEvent.tab();
  await expect(citation).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect(titleLink).toHaveFocus();
  await expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
}
async function editPages(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const pages = within(await canvas.findByRole('region', { name: name('schema:numberOfPages') }));
  const edit = await enabled(pages.getByRole('button', { name: m.facts_edit_field({}, options()) }));
  edit.focus();
  await userEvent.keyboard('{Enter}');
  const amount = pages.getByRole('textbox', { name: m.correction_amount({}, options()) });
  await expect(amount).toHaveValue('+192');
  await expect(pages.getByRole('combobox', { name: m.correction_unit({}, options()) })).toHaveValue('1');
  await expect(pages.getByRole('textbox', { name: m.correction_value({}, options()) })).toHaveValue(
    mangaVolumeCitation,
  );
  await expect(canvas.getByRole('button', { name: m.facts_submit({}, options()) })).toBeDisabled();
  await userEvent.clear(amount);
  await userEvent.type(amount, '+196');
  await expect(amount).toHaveFocus();
  await expect(
    canvas.getByRole('heading', { level: 2, name: m.facts_selection({ count: 1, limit: 12 }, options()) }),
  ).toBeVisible();
  await expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await userEvent.click(await enabled(canvas.getByRole('button', { name: m.facts_submit({}, options()) })));
  return pages;
}
export const FullGroups: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: ({ canvasElement }) => inspectGroups(canvasElement),
};
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop1440', isRotated: false } },
  play: ({ canvasElement }) => inspectGroups(canvasElement),
};
export const Rtl: Story = { ...FullGroups, args: { rtl: true } };
export const RtlDesktop: Story = { ...Desktop, args: { rtl: true } };
export const ProposedAndExactReview: Story = {
  play: async ({ canvasElement }) => {
    const pages = await editPages(canvasElement);
    await expect(await pages.findByText(m.correction_proposed({}, options()))).toBeVisible();
    await expect(pages.getByRole('heading', { name: m.candidate_current({}, options()) })).toBeVisible();
    const review = pages.getByRole('link', { name: m.correction_review({}, options()) });
    const candidate = [...fixture.candidates.keys()][0]!;
    await expect(review).toHaveAttribute('href', expect.stringContaining(`candidate=${candidate}`));
    review.focus();
    await userEvent.keyboard('{Enter}');
    const region = within(await within(canvasElement).findByRole('region', { name: m.candidate_title({}, options()) }));
    await expect(await region.findByRole('heading', { name: m.candidate_proposed({}, options()) })).toBeVisible();
    await expect(region.getByRole('combobox', { name: m.candidate_field({}, options()) })).toBeDisabled();
    const accept = region.getByRole('button', { name: m.candidate_accept({}, options()) });
    accept.focus();
    await userEvent.keyboard('{Enter}');
    const confirmation = region
      .getByRole('heading', {
        name: m.candidate_confirm_title({ action: m.candidate_accept({}, options()) }, options()),
      })
      .closest('section')!;
    await expect(confirmation).toHaveFocus();
    await userEvent.click(within(confirmation).getByRole('button', { name: m.candidate_cancel({}, options()) }));
    await expect(accept).toHaveFocus();
    await expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  },
};
async function failure(canvasElement: HTMLElement, message: string) {
  const pages = await editPages(canvasElement);
  await expect(await pages.findByText(message)).toBeVisible();
  await expect(pages.getByRole('textbox', { name: m.correction_amount({}, options()) })).toHaveValue('+196');
  await expect(within(canvasElement).getByRole('button', { name: m.correction_reload({}, options()) })).toBeEnabled();
}
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: ({ canvasElement }) => failure(canvasElement, m.correction_denied({}, options())),
};
export const Stale: Story = {
  args: { scenario: 'stale' },
  play: ({ canvasElement }) => failure(canvasElement, m.correction_stale({}, options())),
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: ({ canvasElement }) => failure(canvasElement, m.correction_invalid({}, options())),
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: ({ canvasElement }) => failure(canvasElement, m.correction_stale({}, options())),
};
export const UncertainReplay: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    await failure(canvasElement, m.facts_uncertain({}, options()));
    const canvas = within(canvasElement);
    const original = structuredClone(fixture.calls.filter((call) => call.method === 'POST')[0]!);
    await expect(canvas.getByRole('textbox', { name: m.correction_amount({}, options()) })).toBeDisabled();
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.facts_submit({}, options()) })));
    await expect(await canvas.findByText(m.correction_proposed({}, options()))).toBeVisible();
    await expect(fixture.calls.filter((call) => call.method === 'POST')).toEqual([original, original]);
  },
};
export const SignedOut: Story = { args: { signedOut: true } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const NoReleasedFields: Story = { args: { scenario: 'empty' } };
export const IndependentMounts: Story = {
  render: () => (
    <div className="grid min-w-0 gap-8 p-4 lg:grid-cols-2">
      {[0, 1].map((index) => (
        <div key={index} data-correction-mount={index} className="min-w-0">
          <MangaCorrections
            locale={getLocale()}
            disabled={false}
            read={{
              ok: true,
              release: fixture.release,
              releaseDigest: 'manga-fixture-release',
              public: fixture.reads.get(mangaVolumeId)!,
            }}
            ports={{
              facts: { read: async () => ({ ok: false, reason: 'unavailable' }), propose: fixture.propose },
              review: () => ({
                reader: 'fixture',
                read: async () => ({ ok: false, reason: 'unavailable' }),
                confirm: async () => ({ ok: false, reason: 'denied' }),
              }),
              relations: null,
              authored: null,
            }}
            reload={async () => undefined}
          />
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const mounts = [...canvasElement.querySelectorAll<HTMLElement>('[data-correction-mount]')];
    const first = within(mounts[0]!);
    const firstRegion = first.getByRole('region', { name: name('schema:numberOfPages') });
    const pages = within(firstRegion);
    await userEvent.click(pages.getByRole('button', { name: m.facts_edit_field({}, options()) }));
    await expect(within(mounts[1]!).queryByRole('textbox', { name: m.correction_amount({}, options()) })).toBeNull();
    const input = pages.getByRole('textbox', { name: m.correction_amount({}, options()) });
    await userEvent.clear(input);
    await userEvent.type(input, '+196');
    await expect(first.getByRole('button', { name: m.facts_submit({}, options()) })).toBeEnabled();
    await expect(within(mounts[1]!).getByRole('button', { name: m.facts_submit({}, options()) })).toBeDisabled();
    const secondRegion = within(mounts[1]!).getByRole('region', { name: name('schema:numberOfPages') });
    const other = within(secondRegion);
    await userEvent.click(other.getByRole('button', { name: m.facts_edit_field({}, options()) }));
    const include = pages.getByRole('checkbox', { name: m.facts_include({}, options()) });
    const otherInclude = other.getByRole('checkbox', { name: m.facts_include({}, options()) });
    const includeId = firstRegion.querySelector<HTMLInputElement>('input[type="checkbox"]')!.id;
    const otherIncludeId = secondRegion.querySelector<HTMLInputElement>('input[type="checkbox"]')!.id;
    await expect(includeId).not.toBe('');
    await expect(otherIncludeId).not.toBe(includeId);
    otherInclude.focus();
    await userEvent.keyboard(' ');
    await expect(otherInclude).not.toBeChecked();
    await expect(include).toBeChecked();
    await expect(other.getByRole('textbox', { name: m.correction_amount({}, options()) })).toHaveValue('+192');
    await expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  },
};

export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await editPages(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: m.correction_saving({}, options()) })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.correction_reload({}, options()) })).toBeDisabled();
  },
};
export const DeliberateReload: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: name('schema:numberOfPages') });
    const before = fixture.calls.filter((call) => call.method === 'GET').length;
    const reload = await enabled(canvas.getByRole('button', { name: m.correction_reload({}, options()) }));
    reload.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(before + 3));
    await expect(reload).toHaveFocus();
    await expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  },
};

export const ObservedGlobal: Story = { args: { origin: 'global' } };
export const SelectedContext: Story = {
  args: { origin: 'selected' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.manga_origin_unsupported({}, options()));
    const choice = canvas.getByRole('link', { name: m.manga_origin_global({}, options()) });
    choice.focus();
    await expect(choice).toHaveFocus();
    await expect(canvas.queryByRole('textbox')).toBeNull();
  },
};
export const RetainedRealm: Story = { args: { origin: 'realm' } };
export const FreshGlobal: Story = { args: { origin: 'fresh' } };
