import type { Meta, StoryObj } from '@storybook/react-vite';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { useEffect } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { SubjectPage, pageContext, pageRelationProperties } from '../features/pages/subject';
import { subjectPageMessages } from '../features/pages/route-support';
import type { Snak, Stmt } from '../features/pages/shared';
import type { SubjectSummary } from '../media/summary';
import { qualifiedRelationsPage, qualifiedRealm } from '../kernel/fake/qualified-relations';
import definitions from '../kernel/recorded/definitions-release.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { foreignLanguageName } from '../subject/language';
import { relationDefinitions } from '../subject/relations';
import { subjectHref } from '../subject/subject-href';
import { PatternStory } from './page';

const meta = {
  title: 'Subjects/Unavailable Qualified Credits',
  id: 'pages-subjects-unavailable-qualified-credits',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: { phone320: { name: 'Phone 320', styles: { width: '320px', height: '900px' }, type: 'mobile' } },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type CreditRow = {
  statement: Stmt;
  target: string;
  label: string;
  summary: NonNullable<SubjectSummary>;
  related: Record<string, SubjectSummary>;
};
const snak = (id: string, data_type: string, content: unknown): Snak => ({
  property: { id, data_type },
  value: { type: 'value', content },
});
const personLabel = 'Alexandra — 旅人の声 — ' + 'InternationalPerformer'.repeat(8);
const roleLabel = 'Narrator — 語り手 — الراوي\n' + 'ArchivalVoice'.repeat(12);
const creditedAs = '旅人の声と回想場面の語り\n復元された国際版';
const arabicName = 'صوت الراوي في النسخة الأصلية';
const longNote = 'RestoredEdition'.repeat(16) + '\nOriginal spelling retained';

/** An existing page response with supplied qualifier labels unavailable, not a new native producer fixture. */
function readingPage() {
  const page = structuredClone(qualifiedRelationsPage({ realm: qualifiedRealm }));
  page.document.content = page.document.content.filter((node) => ['header', 'cast'].includes(String(node.props.id)));
  delete page.document.content.find((node) => node.props.id === 'cast')!.props.title;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const cast = page.reads[plan.nodes.cast!]!.body as { relations: CreditRow[] };
  const first = cast.relations[0]!;
  const role = String(first.statement.qualifiers.find((q) => q.property.id === 'wdt:P3831')!.value.content);
  const character = String(first.statement.qualifiers.find((q) => q.property.id === 'wdt:P453')!.value.content);
  const part = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99';
  first.label = personLabel;
  first.summary.label = { value: personLabel, language: 'en' };
  first.related = {
    [role]: { ...first.related[role]!, label: { value: roleLabel, language: 'en' } },
    [character]: null,
    [part]: { id: part, type: 'wd:Q2620972', label: { value: ' \n\t', language: 'en' } },
  };
  first.statement.qualifiers = [
    snak('wdt:P1545', 'quantity', { amount: '+0002.50', unit: '1' }),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P453', 'wikibase-item', character),
    snak('wdt:P1932', 'monolingualtext', { text: creditedAs, language: 'ja' }),
    snak('wdt:P518', 'wikibase-item', part),
    snak('schema:character', 'wikibase-item', character),
    snak('schema:position', 'external-id', 'II'),
    snak('wdt:P1932', 'string', longNote),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P1932', 'monolingualtext', { text: arabicName, language: 'ar' }),
  ];
  const unqualified = structuredClone(first);
  unqualified.statement.id = 'unqualified-credit';
  unqualified.statement.qualifiers = [];
  unqualified.label = 'A genuinely unqualified performer';
  const spoiler = structuredClone(first);
  spoiler.statement.id = 'spoiler-credit';
  spoiler.label = 'Spoiler performer';
  spoiler.statement.qualifiers = [
    snak('wdt:P1932', 'string', 'Concealed credited name'),
    snak('wdt:P453', 'wikibase-item', character),
    snak('rezics:spoilerLevel', 'quantity', { amount: '+2', unit: '1' }),
  ];
  cast.relations = [first, unqualified, spoiler];
  return { page, role, character, part, person: first.target };
}

function Reading({ enlarged = false, rtl = false }: { enlarged?: boolean; rtl?: boolean }) {
  const { page } = readingPage();
  const locale = getLocale();
  useEffect(() => {
    if (!enlarged) return;
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '200%';
    return () => {
      document.documentElement.style.fontSize = previous;
    };
  }, [enlarged]);
  return (
    <PatternStory>
      <main lang={locale} dir={rtl ? 'rtl' : 'ltr'} className="mx-auto w-full max-w-4xl px-4 py-8">
        <SubjectPage
          page={page}
          locale={locale}
          messages={subjectPageMessages()}
          relations={relationDefinitions(definitions.release, pageRelationProperties(page), locale)}
          reader={{ spoilerLevel: 0, suitability: 'blur' }}
          renderJsonLd={false}
        />
      </main>
    </PatternStory>
  );
}

// Authored browser acceptance. It remains unexecuted until the controller's browser verification.
const readingJourney: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const title = await canvas.findByRole('link', { name: personLabel });
  const credit = title.closest('article')!;
  const list = title.closest('ul[aria-label]')!;
  const { role, character, part, person } = readingPage();
  const locale = getLocale();
  const options = { locale };
  const unavailable = m.subject_value_unlabelled({}, options);
  const named = m.subject_credit_named({}, options);
  const rolePrefix = m.subject_credit_role({}, options);
  const characterPrefix = m.subject_credit_character({}, options);
  const order = m.subject_credit_order({}, options);
  const partPrefix = m.subject_credit_part({}, options);
  const badge = (lang: string) => {
    const name = foreignLanguageName(lang, locale);
    return name ? ` ${name}` : '';
  };
  const facts = within(credit).getAllByRole('listitem');
  await expect(facts.map((fact) => fact.textContent)).toEqual([
    `${order}: +0002.50`,
    `${rolePrefix}: ${roleLabel}`,
    `${characterPrefix}: ${unavailable}`,
    `${named}: ${creditedAs}${badge('ja')}`,
    `${partPrefix}: ${unavailable}`,
    `${characterPrefix}: ${unavailable}`,
    `${order}: II`,
    `${named}: ${longNote}`,
    `${rolePrefix}: ${roleLabel}`,
    `${named}: ${arabicName}${badge('ar')}`,
  ]);
  for (const index of [2, 4, 5]) {
    await expect(facts[index]).toBeVisible();
    await expect(facts[index]!.querySelector('a')).toBeNull();
  }
  for (const id of [character, part]) await expect(canvasElement.innerHTML).not.toContain(id);
  await expect(credit.querySelector('a a')).toBeNull();
  await expect(credit.querySelector('[lang="ja"]')).toHaveTextContent(creditedAs.replace(/\s+/gu, ' '));
  await expect(credit.querySelector('[lang="ar"]')).toHaveTextContent(arabicName);
  const rows = Array.from(list.children);
  await expect(rows.map((row) => row.tagName)).toEqual(['LI', 'LI', 'LI']);
  await expect(rows[1]!.querySelector('ul')).toBeNull();
  await expect(within(rows[1]! as HTMLElement).getAllByRole('link')).toHaveLength(1);
  await expect(canvas.queryByText('Spoiler performer')).toBeNull();
  await expect(canvas.queryByText('Concealed credited name')).toBeNull();

  const links = within(credit).getAllByRole('link');
  const primary = `${subjectHref({ id: person, label: personLabel }, locale).href}?realm=${qualifiedRealm}`;
  const secondary = `${subjectHref({ id: role, label: roleLabel }, locale).href}?realm=${qualifiedRealm}`;
  await expect(links.map((link) => link.getAttribute('href'))).toEqual([primary, secondary, secondary]);
  const destinations: string[] = [];
  const observeNavigation = (event: Event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor && credit.contains(anchor)) {
      event.preventDefault();
      destinations.push(anchor.getAttribute('href')!);
    }
  };
  canvasElement.addEventListener('click', observeNavigation, true);
  try {
    title.focus();
    for (let index = 0; index < links.length; index++) {
      if (index > 0) await userEvent.tab();
      await expect(document.activeElement).toBe(links[index]);
      await userEvent.keyboard('{Enter}');
      await expect(destinations.pop()).toBe(index === 0 ? primary : secondary);
      const target = links[index]!.getBoundingClientRect();
      await expect(target.width).toBeGreaterThanOrEqual(44);
      await expect(target.height).toBeGreaterThanOrEqual(44);
    }
  } finally {
    canvasElement.removeEventListener('click', observeNavigation, true);
  }
  await document.fonts.ready;
  const fields = credit.querySelector('[data-slot="cover-card-essential-credit"]')!;
  await expect(fields.scrollWidth).toBeLessThanOrEqual(fields.clientWidth + 1);
  await expect(getComputedStyle(fields).overflowY).toBe('visible');
  for (const fact of facts) await expect(fact.scrollHeight).toBeLessThanOrEqual(fact.clientHeight + 1);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  const more = within(list.closest('section')!).getByRole('link', {
    name: m.subject_section_more({ label: m.subject_cast({}, options) }, options),
  });
  const continuation = new URL(more.getAttribute('href')!, window.location.href);
  await expect(continuation.searchParams.get('node')).toBe('cast');
  await expect(continuation.searchParams.get('cursor')).toBe('cast-next');
  await expect(continuation.searchParams.get('realm')).toBe(qualifiedRealm);
  const show = canvas.getByRole('button', { name: m.subject_spoiler_show({}, options) });
  await expect(show.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await userEvent.click(show);
  const revealed = (await canvas.findByRole('link', { name: 'Spoiler performer' })).closest('article')!;
  await expect(within(revealed).getByText(`${characterPrefix}: ${unavailable}`).closest('a')).toBeNull();
  await expect(revealed).toHaveTextContent('Concealed credited name');
  for (const id of [character, part]) await expect(canvasElement.innerHTML).not.toContain(id);
  await userEvent.click(canvas.getByRole('button', { name: m.subject_spoiler_hide({}, options) }));
  await expect(canvas.queryByRole('link', { name: 'Spoiler performer' })).toBeNull();
};

export const Narrow320: Story = {
  globals: {},
  render: () => <Reading />,
  play: readingJourney,
};
export const Text200Percent320: Story = {
  globals: {},
  render: () => <Reading enlarged />,
  play: readingJourney,
};
export const RightToLeft320: Story = {
  globals: {},
  render: () => <Reading rtl />,
  play: readingJourney,
};
export const Desktop: Story = {
  globals: {},
  render: () => <Reading />,
  play: readingJourney,
};
