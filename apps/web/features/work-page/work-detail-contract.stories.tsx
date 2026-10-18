import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { zoneMemberHref } from '../address/path.ts';
import { workExperience } from '../entity-page/experience.ts';
import * as entity from '../entity-page/fixtures.ts';
import type { StatementPage } from '../entity-page/types.ts';
import { copyOf as entityCopy } from '../entity-page/messages.ts';
import { attributed } from '../rights-mark/fixtures.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';
import * as levels from '../work-levels/fixtures.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { PartsPreviewView } from '../work-levels/previews.tsx';
import { BooksEditionPage } from './books-edition-page.tsx';
import * as fixture from './fixtures.ts';
import { hubLabels, hubSections } from './hub.ts';
import { messages } from './messages.ts';
import { RatingSummaryRegion } from './ratings.tsx';
import { workHref, type WorkAt } from './route.ts';
import { GuideExperience } from './types/guide.tsx';
import { WorkKindActions } from './types/actions.tsx';
import { OverviewLayout, WorkFrame } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';
import { WikiSectionView } from './wiki.tsx';
import { WorkFactsView } from './work-sources.tsx';

const english = [
  'At the harbour entrance, the chart shows a channel between the old breakwater and a line of green buoys. '
    + 'Read the tide table before setting out, then compare it with the marks on the stone steps. '
    + 'The time printed in a guide is only a starting point: wind, river flow and the shape of the coast all change the water you will meet.',
  'Choose a place from which the entire crossing is visible. Watch one complete cycle of the lights and identify the return route before you move. '
    + 'If another boat approaches the narrow passage, wait where there is room to turn. A short pause gives everyone more time to understand the same scene.',
  'Keep the chart within reach, and write down the landmark that tells you when to turn. Check the weather again before leaving the sheltered water. '
    + 'When a familiar marker has moved, describe what you can actually see and find another point of reference rather than forcing the view to match your memory.',
];
const chinese = [
  '抵达港口入口时，先找到旧防波堤与绿色浮标之间的航道。出发前查看潮汐表，再对照石阶上的水位痕迹。'
    + '指南中标注的时间只是参考，风向、河流流量与海岸的形状都会影响眼前的水面。沿岸观察一段时间，确认返航时仍能辨认相同的地标。',
  '选择能够看清整个渡口的位置，观察一轮信号灯，再确认可以安全返回的路线。如果另一艘船正在接近狭窄的通道，就在有足够转向空间的地方等待。'
    + '短暂的停留能让每个人有时间理解同一片水域，也能让同行者说明自己看到的情况。',
  '把海图放在随手可取的位置，记下提示转向的地标。离开避风水域之前，再次核实天气。当熟悉的标记已经移动时，先描述实际看到的景象，再寻找其他可靠的参照。'
    + '不要为了符合过去的记忆而忽略新的变化；将观察记录下来，下一次进入港口时便能更从容地作出判断。',
];
const zone: WorkAt = { ref: fixture.workRef, path: zoneMemberHref('tidewater', 'library', fixture.workRef), realm: levels.current };

function LongGuide({ locale = 'en', short = false }: { locale?: UiLocale; short?: boolean }) {
  const zh = locale === 'zh-Hans';
  const title = zh ? '沿着潮汐进入港口' : 'Finding a safe route into the harbour';
  const paragraphs = zh ? chinese : english;
  const headings = zh ? ['出发前的观察', '辨认航道', '准备返航'] : ['Before departure', 'Finding the channel', 'Planning the return'];
  const body = short ? `# ${title}\n${paragraphs[0]}`
    : headings.map((heading, index) => `# ${heading}\n${paragraphs[index]}\n${paragraphs[(index + 1) % 3]}`).join('\n');
  const work = { ...fixture.metadataOnlyWork, disclosure: 'public' as const, publicationState: 'published' as const,
    types: ['https://schema.org/DigitalDocument'], title: { ...fixture.work.title, value: title, language: locale },
    selectedLanguage: locale, factObligations: attributed, description: null };
  return <WorkFrame workRef={fixture.workRef} work={work} credits={<p>{zh ? '林晓' : 'Maren Osei'}</p>}
    locale={locale} messages={messages[locale]} readAction={<WorkKindActions kind="guide" workId={work.id}
      title={title} locale={locale} messages={messages[locale]} />}>
    <GuideExperience body={body} title={title} updatedAt="2026-10-16T08:00:00Z" locale={locale} messages={messages[locale]} />
  </WorkFrame>;
}

const meta = {
  title: 'Work page/Detail contract',
  component: LongGuide,
  args: { locale: 'en', short: false },
  parameters: {
    route: { pathname: workHref(fixture.workRef), search: '' },
    viewport: { options: {
      detail1024: { name: 'Detail 1024 × 900', styles: { width: '1024px', height: '900px' }, type: 'tablet' },
      detail768: { name: 'Detail 768 × 1024', styles: { width: '768px', height: '1024px' }, type: 'tablet' },
    } },
  },
} satisfies Meta<typeof LongGuide>;
export default meta;
type Story = StoryObj<typeof meta>;

async function readableGuide({ canvasElement, args }: { canvasElement: HTMLElement; args: { locale?: UiLocale } }) {
  await document.fonts.ready;
  const canvas = within(canvasElement);
  const article = canvasElement.querySelector<HTMLElement>('#guide-experience article')!;
  const paragraph = article.querySelector('p')!;
  await expect(paragraph).toBeVisible();
  // The limit scales with the actual font's ch unit, rather than assuming a pixel width.
  const measure = document.createElement('span');
  measure.style.cssText = 'position:absolute;visibility:hidden;width:70ch';
  measure.style.font = getComputedStyle(paragraph).font;
  paragraph.append(measure);
  const maximum = measure.getBoundingClientRect().width;
  measure.remove();
  await expect(article.getBoundingClientRect().width).toBeLessThanOrEqual(maximum + 1);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  const guide = within(canvasElement.querySelector<HTMLElement>('#guide-experience')!);
  if (window.innerWidth < 1280) {
    const contents = guide.getByText(messages[args.locale ?? 'en'].tableOfContents,
      { selector: 'summary' });
    await expect(contents).toBeVisible();
    await userEvent.click(contents);
  }
  const contents = guide.getByRole('navigation');
  await expect(within(contents).getAllByRole('link')).toHaveLength(3);
  const sources = canvasElement.querySelector<HTMLElement>('[data-work-sources]')!;
  await expect(sources.getBoundingClientRect().top).toBeGreaterThan(article.getBoundingClientRect().bottom);
  await expect(within(sources).getByRole('link', { name: 'CC BY-SA 3.0' })).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
}

export const LongEnglish1440: Story = { globals: { viewport: { value: 'desktop1440' } }, play: readableGuide };
export const LongEnglish1024: Story = { globals: { viewport: { value: 'detail1024' } }, play: readableGuide };
export const LongEnglish768: Story = { globals: { viewport: { value: 'detail768' } }, play: readableGuide };
export const LongEnglish390: Story = { globals: { viewport: { value: 'phone' } }, play: readableGuide };
export const LongChinese1440: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'desktop1440' } }, play: readableGuide };
export const LongChinese1024: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'detail1024' } }, play: readableGuide };
export const LongChinese768: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'detail768' } }, play: readableGuide };
export const LongChinese390: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } }, play: readableGuide };
export const ShortGuide: Story = {
  args: { short: true }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const guide = within(canvasElement.querySelector<HTMLElement>('#guide-experience')!);
    await expect(guide.queryByRole('navigation')).toBeNull();
    await expect(guide.queryByRole('heading')).toBeNull();
    await expect(guide.getByText(english[0]!)).toBeVisible();
  },
};

function Navigation({ at }: { at: WorkAt }) {
  return <WorkFrame workRef={at} work={fixture.work} credits={null} locale="en" messages={messages.en}
    sections={hubLabels(messages.en, hubSections)}><p tabIndex={0}>Connections for this work</p></WorkFrame>;
}
const navigationSearch = `scope=global&language=ja&open=${fixture.workRef}`;
async function dismissibleNavigation(canvasElement: HTMLElement, at: WorkAt) {
  const canvas = within(canvasElement);
  const trigger = canvas.getByRole('button', { name: messages.en.pageSections });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const nav = canvas.getByRole('navigation', { name: messages.en.pageSections });
  await expect(within(nav).getByRole('link', { name: 'Connections' })).toHaveAttribute('aria-current', 'page');
  await expect(within(nav).getAllByRole('link').filter(link => link.hasAttribute('aria-current'))).toHaveLength(1);
  await expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('href',
    localizedPath(workHref(at, 'overview', { kind: 'global' }, { language: 'ja', open: fixture.workRef }), 'en'));
  await expect(within(nav).queryByRole('menuitem')).toBeNull();
  await userEvent.keyboard('{Escape}');
  await expect(trigger).toHaveFocus();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await userEvent.keyboard(' ');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(canvas.getByRole('heading', { level: 1 }));
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(trigger);
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  await userEvent.click(trigger);
  const stop = (event: Event) => event.preventDefault();
  document.addEventListener('click', stop);
  try { await userEvent.click(canvas.getByRole('link', { name: 'Overview' })); }
  finally { document.removeEventListener('click', stop); }
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toHaveFocus();
  const more = canvas.getByRole('button', { name: `${relationshipMessages.en.options} · ${fixture.work.title.value}` });
  await expect(more).toBeVisible();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}
export const MobileConnections: Story = {
  render: () => <Navigation at={fixture.workRef} />,
  parameters: { route: { pathname: workHref(fixture.workRef, 'connections'), search: navigationSearch } },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await dismissibleNavigation(canvasElement, fixture.workRef); },
};
export const ZoneMobileConnections: Story = {
  ...MobileConnections,
  render: () => <Navigation at={zone} />,
  parameters: { route: { pathname: workHref(zone, 'connections'), search: navigationSearch } },
  async play({ canvasElement }) { await dismissibleNavigation(canvasElement, zone); },
};
export const DesktopEditions: Story = {
  render: () => <Navigation at={fixture.workRef} />,
  parameters: { route: { pathname: workHref(fixture.workRef, 'editions'), search: navigationSearch } },
  globals: { viewport: { value: 'desktop1440' } },
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: messages.en.sections });
    await expect(within(nav).getByRole('link', { name: 'Editions' })).toHaveAttribute('aria-current', 'page');
    await expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  },
};

function SparseBook({ failed = false }: { failed?: boolean }) {
  const t = messages.en;
  const work = { ...fixture.work, descriptionObligations: attributed, factObligations: attributed };
  const releases = levels.releases.ok ? { ok: true as const, data: { ...levels.releases.data, items: [] } } : levels.releases;
  const parts = levels.parts.ok ? { ok: true as const, data: { ...levels.parts.data, parts: [] } } : levels.parts;
  const wholes = levels.wholes.ok ? { ok: true as const, data: { ...levels.wholes.data, wholes: [] } } : levels.wholes;
  return <WorkFrame workRef={fixture.workRef} work={work} experience={workExperience(null, work.types)} credits={null}
    locale="en" messages={t}>
    <OverviewLayout plan={hubSections} messages={t} scopeBar={null} record={null} about={<WorkAbout work={work} messages={t} />}
      availability={<BooksEditionPage work={work.id} releases={failed ? { ok: false, failure: 'unavailable' } : releases}
        locale="en" messages={t} signInHref="/auth/start" editionsHref={workHref(fixture.workRef, 'editions')} />}
      parts={<PartsPreviewView parts={failed ? { ok: false, failure: 'missing' } : parts} wholes={wholes}
        names={levels.names} workRef={fixture.workRef} t={levelsCopy('en')} pageMessages={t} />}
      wiki={<WikiSectionView wiki={{ zone: failed ? { ok: false, failure: 'unavailable' } : { ok: true, data: null }, characters: null }}
        locale="en" messages={t} />}
      ratings={<RatingSummaryRegion ratings={fixture.globalRatings} view={fixture.scopeView(fixture.globalScope)}
        locale="en" messages={t} />}
      discussion={<a href={workHref(fixture.workRef, 'discussion')}>Join the discussion</a>} />
  </WorkFrame>;
}
export const SparseBookWithRatings: Story = {
  render: () => <SparseBook />, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('alert')).toBeNull();
    for (const empty of canvasElement.querySelectorAll<HTMLElement>('[data-hub-empty]')) {
      await expect(empty.getBoundingClientRect().height).toBeLessThan(130);
      await expect(within(empty).queryByRole('heading')).toBeNull();
    }
    await expect(canvas.getByRole('link', { name: 'Join the discussion' })).toBeVisible();
    const sources = canvasElement.querySelector<HTMLElement>('[data-work-sources]')!;
    await expect(within(sources).getAllByRole('link', { name: 'CC BY-SA 3.0' })).toHaveLength(1);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const MixedReadFailures: Story = {
  render: () => <SparseBook failed />, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('alert')).toHaveLength(3);
    for (const alert of canvas.getAllByRole('alert')) await expect(within(alert).getByRole('button', { name: messages.en.retry })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Join the discussion' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
  },
};

function SourcedWork() {
  const t = messages.en;
  const page: StatementPage = { ...entity.statements(), factObligations: attributed, groups: [
    { predicate: 'https://schema.org/identifier', items: [{ ...entity.componentStatements.groups[0]!.items[0]!, kind: 'component-property',
      predicate: 'https://schema.org/identifier', value: { kind: 'external', provider: 'Open Library', namespace: 'works', key: 'OL123W' },
      sources: ['https://openlibrary.org/works/OL123W?revision=7'] }] },
    ...entity.statements().groups,
  ] };
  const work = { ...fixture.work, factObligations: attributed, descriptionObligations: attributed };
  return <WorkFrame workRef={fixture.workRef} work={work} credits={null} locale="en" messages={t}
    statementSources={{ ok: true, data: page }} sourceLabels={entity.predicateLabels} factObligations={[attributed]}>
    <WorkAbout work={work} messages={t} />
    <WorkFactsView page={{ ok: true, data: page }} labels={entity.predicateLabels} names={new Map()}
      hrefFor={() => workHref(fixture.workRef)} locale="en" t={entityCopy('en')} messages={t} />
  </WorkFrame>;
}
export const SourcesAndEvidence: Story = {
  render: () => <SourcedWork />, globals: { viewport: { value: 'desktop1440' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const sources = canvas.getByRole('region', { name: messages.en.sourcesAndEvidence });
    await expect(canvasElement.querySelectorAll('[data-work-sources]')).toHaveLength(1);
    await expect(within(sources).getAllByRole('link', { name: 'CC BY-SA 3.0' })).toHaveLength(1);
    await expect(within(sources).getByText('Open Library · works · OL123W')).toBeVisible();
    const details = within(sources).getByText(messages.en.fieldEvidence, { selector: 'summary' });
    details.focus();
    await userEvent.keyboard('{Enter}');
    const evidence = within(sources).getByRole('link', { name: 'Evidence 1' });
    await expect(evidence).toHaveAttribute('href', 'https://openlibrary.org/works/OL123W?revision=7');
    await expect(within(sources).getAllByText(messages.en.fieldEvidenceUnavailable).length).toBeGreaterThan(0);
    evidence.focus();
    await expect(evidence).toHaveFocus();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const MobileSourcesAndEvidence: Story = { ...SourcesAndEvidence, globals: { viewport: { value: 'phone' } } };

function CrossViewTask({ kind }: { kind: 'recipe' | 'guide' }) {
  const t = messages.en;
  return <WorkFrame workRef={zone} work={fixture.work} credits={null} locale="en" messages={t}
    experience={workExperience(null, [kind === 'recipe' ? 'https://schema.org/Recipe' : 'https://schema.org/DigitalDocument'])}
    readAction={<WorkKindActions kind={kind} workId={fixture.work.id} workRef={zone} title={fixture.work.title.value}
      locale="en" messages={t} />}>
    <p>Connections for {fixture.work.title.value}</p>
  </WorkFrame>;
}
export const RecipeTaskFromConnections: Story = {
  render: () => <CrossViewTask kind="recipe" />, globals: { viewport: { value: 'phone' } },
  parameters: { route: { pathname: workHref(zone, 'connections'), search: navigationSearch } },
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: messages.en.cookThis });
    const url = new URL(link.getAttribute('href')!, window.location.origin);
    await expect(url.pathname).toBe(localizedPath(workHref(zone), 'en'));
    await expect(url.hash).toBe('#cook');
    await expect(url.searchParams.get('language')).toBe('ja');
    await expect(url.searchParams.get('scope')).toBe('global');
  },
};
export const GuideTaskFromConnections: Story = {
  ...RecipeTaskFromConnections, render: () => <CrossViewTask kind="guide" />,
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: messages.en.viewGuide });
    const url = new URL(link.getAttribute('href')!, window.location.origin);
    await expect(url.pathname).toBe(localizedPath(workHref(zone), 'en'));
    await expect(url.hash).toBe('#guide-experience');
    await expect(url.searchParams.get('language')).toBe('ja');
  },
};
