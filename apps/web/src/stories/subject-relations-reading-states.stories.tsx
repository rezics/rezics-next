import type { Meta, StoryObj } from '@storybook/react-vite';
import { slug } from '@rezics/definitions/slug';
import { useLayoutEffect, useRef } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { RelationsView, type RelationsViewData } from '../features/pages/relations-view';
import { SubjectFrame, subjectFrame } from '../features/pages/subject-frame';
import type { SubjectPageData } from '../features/pages/subject';
import { SubjectLink, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import pageRecording from '../kernel/recorded/subject-page.json';
import linksRecording from '../kernel/recorded/subject-links.json';
import { qualifiedStatement } from '../kernel/fake/qualified-relations';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PendingPage } from '../shell/pending';
import { defaultReader } from '../subject/reader';
import type { RelationDefinition } from '../subject/relations';
import { PatternStory } from './page';

const cursor = 'opaque:/+?=&% 日本語#';
const overview = pageRecording as unknown as SubjectPageData;
const longTitle = `語り手 ${'UnbrokenReadingTitle'.repeat(16)} العربية`;
const longRelation = `Adaptation · 改編作品 · ${'WeitereBeziehungen'.repeat(12)}`;
const role = { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e96', label: 'Principal narrator' };
const withheld = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e98';
const credit = {
  ...linksRecording.links[1]!,
  label: 'Ada Player',
  assertion: qualifiedStatement('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e97', 'wdt:P155', pageRecording.subject, [
    { property: { id: 'wdt:P3831', data_type: 'wikibase-item' }, value: { type: 'value', content: role.id } },
    {
      property: { id: 'wdt:P1932', data_type: 'monolingualtext' },
      value: { type: 'value', content: { text: '朗読者', language: 'ja' } },
    },
  ]),
  related: { [role.id]: { id: role.id, label: { value: role.label, language: 'en' } } },
};
type State =
  | 'grouped'
  | 'property'
  | 'empty'
  | 'sparse'
  | 'withheld'
  | 'failed'
  | 'failed-property'
  | 'loading'
  | 'credit';
type Props = { state: State; longLabels: boolean; direction: 'ltr' | 'rtl'; enlargedText: boolean };

/** Supplied native-shaped pages mount the same compact frame and exported RelationsView as the standalone route. */
function ReadingContent({ state, longLabels, direction, enlargedText }: Props) {
  const locale = getLocale();
  const options = { locale };
  const frame = subjectFrame(overview, locale)!;
  const subject = { id: frame.id, label: frame.title.text };
  const failed = state === 'failed' || state === 'failed-property';
  const region = useRef<HTMLDivElement>(null);
  const relations: Record<string, RelationDefinition> = {
    'wdt:P155': { label: 'Sequel', group: 'order', symmetric: false },
    'wdt:P144': { label: longLabels ? longRelation : 'Adaptation', group: 'derivation', symmetric: false },
    'rezics:sameSetting': { label: 'Same setting', group: 'world', symmetric: true },
  };
  const data: RelationsViewData = {
    property: state === 'property' || state === 'failed-property' ? 'wdt:P155' : null,
    body: failed
      ? {}
      : {
          links:
            state === 'empty' || state === 'sparse'
              ? []
              : state === 'withheld'
                ? [{ subject: withheld, label: 'Withheld title', summary: null }]
                : state === 'credit'
                  ? [{ ...credit, label: longLabels ? longTitle : credit.label }]
                  : linksRecording.links
                      .filter((link) => state !== 'property' || link.property === 'wdt:P155')
                      .map((link, index) => ({ ...link, label: longLabels && index === 0 ? longTitle : link.label })),
          count: { value: state === 'empty' ? 0 : 37, exact: state === 'empty' || state === 'grouped' },
          next: state === 'empty' ? null : cursor,
        },
  };
  // Presentation-only stress of the actual production anchor, with no alternate control or locale catalogue edit.
  useLayoutEffect(() => {
    const anchor = region.current?.querySelector('[data-slot="next-page"], [data-slot="restart-page"]');
    if (!longLabels || !anchor) return;
    const original = anchor.textContent;
    const label = failed ? m.subject_relation_restart({}, options) : m.subject_relations_more({}, options);
    anchor.textContent = `${label} / 次の関係 / ${'WeitereBeziehungen'.repeat(16)}`;
    return () => {
      anchor.textContent = original;
    };
  }, [longLabels, locale, state, failed]);
  useLayoutEffect(() => {
    if (!enlargedText) return;
    const root = document.documentElement;
    const original = root.style.fontSize;
    root.style.fontSize = '200%';
    return () => {
      root.style.fontSize = original;
    };
  }, [enlargedText]);
  return (
    <div ref={region} data-slot="relations-reading-example" lang={locale} dir={direction}>
      {state === 'loading' ? (
        <PendingPage />
      ) : (
        <RelationsView
          locale={locale}
          subject={subject}
          frame={
            <SubjectFrame
              frame={frame}
              locale={locale}
              link={SubjectLink}
              reader={defaultReader}
              unlabelled={m.subject_value_unlabelled({}, options)}
              tabs={subjectTabs(overview)}
              tabLabels={viewTabLabels()}
              view="relations"
            />
          }
          data={data}
          relations={relations}
          value={{
            locale,
            link: SubjectLink,
            reader: defaultReader,
            unlabelled: m.subject_value_unlabelled({}, options),
            spoilerShow: m.subject_spoiler_show({}, options),
            labels: {
              spoilerShow: m.subject_spoiler_show({}, options),
              documentSpoiler: m.thread_reveal_spoiler({}, options),
              cover: {
                withheld: m.subject_cover_withheld({}, options),
                reveal: m.subject_cover_reveal({}, options),
                credit: m.subject_cover_credit({}, options),
                via: m.subject_cover_via({}, options),
              },
            },
          }}
        />
      )}
    </div>
  );
}

function ReadingPage(props: Props) {
  const frame = subjectFrame(overview, getLocale())!;
  return (
    <PatternStory path={`/subjects/${frame.id}/${slug(frame.title.text)}/relations`}>
      <AppShell>
        <ReadingContent {...props} />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Relations Reading States',
  component: ReadingPage,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone320: { name: 'Phone 320', styles: { width: '320px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        component:
          'Authored UNRUN under MINIMAL: actual standalone RelationsView, SubjectFrame, CoverList and shell. Recorded Subject/links supply the identities; sparse/count/qualifier/long-text variants are supplied presentation examples, not native authorization or signed-cursor proof. Empty copy describes only this page. Long-label plays stress the actual next anchor with a multilingual expanded label; its target is unchanged. Review all eight supported locale and theme globals. RTL stresses direction with a supported locale. The 200% case doubles the root text size and restores it on unmount. Native, browser, visual, full and integration acceptance remain deferred.',
      },
    },
  },
  args: { state: 'grouped', longLabels: false, direction: 'ltr', enlargedText: false },
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement, args }) => {
    if (args.state === 'loading') {
      const view = within(canvasElement);
      const pending = await view.findByRole('region', { name: m.candidate_loading() });
      await expect(pending).toHaveAttribute('aria-busy', 'true');
      await expect(view.queryByRole('alert')).toBeNull();
      await expect(view.queryByText(m.subject_relation_empty_page())).toBeNull();
      await expect(pending.querySelector('a, button')).toBeNull();
      return;
    }
    const heading = await within(canvasElement).findByRole('heading', { level: 1 });
    const region = heading.closest<HTMLElement>('[data-slot="relations-reading-example"]')!;
    const view = within(region);
    const locale = getLocale();
    const options = { locale };
    const frame = subjectFrame(overview, locale)!;
    await expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expect(heading).toHaveTextContent(
      args.state === 'property' || args.state === 'failed-property' ? 'Sequel' : m.subject_relations({}, options),
    );
    await expect(region.querySelector('[data-slot="subject-frame"]')).toBeVisible();
    await expect(region.querySelector('[data-slot="view-tabs"] [aria-current="page"]')).toHaveAttribute(
      'data-view',
      'relations',
    );
    const count = region.querySelector('[data-slot="view-heading"] [data-slot="count"]');
    const next = region.querySelector<HTMLAnchorElement>('[data-slot="next-page"]');
    if (args.state === 'failed' || args.state === 'failed-property') {
      await expect(view.getByRole('alert')).toHaveTextContent(m.subject_section_failed({}, options));
      await expect(view.queryByText(m.subject_relation_empty_page({}, options))).toBeNull();
      await expect(count).toBeNull();
      await expect(next).toBeNull();
      const restart = region.querySelector<HTMLAnchorElement>('[data-slot="restart-page"]')!;
      const query = args.state === 'failed-property' ? '?property=wdt%3AP155' : '';
      const expected = `/${locale}/subjects/${frame.id}/${slug(frame.title.text)}/relations${query}`;
      await expect(restart).toHaveAttribute('href', expected);
      await expect(restart).toHaveTextContent(m.subject_relation_restart({}, options));
      await expect(restart).toBeVisible();
      await expect(restart.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(restart.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      const style = getComputedStyle(restart);
      await expect(style.whiteSpace).toBe('normal');
      await expect(style.overflowWrap).toBe('anywhere');
      await expect(restart.scrollWidth).toBeLessThanOrEqual(restart.clientWidth + 1);
      await expect(restart.scrollHeight).toBeLessThanOrEqual(restart.clientHeight + 1);
      await expect(restart.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        region.getBoundingClientRect().left - 1,
      );
      await expect(restart.getBoundingClientRect().right).toBeLessThanOrEqual(region.getBoundingClientRect().right + 1);
      if (args.longLabels) {
        await expect(restart).toHaveTextContent('WeitereBeziehungen'.repeat(16));
        await expect(style.overflow).not.toBe('hidden');
        await expect(style.textOverflow).not.toBe('ellipsis');
        await expect(restart.getBoundingClientRect().height).toBeGreaterThan(parseFloat(style.lineHeight) * 2);
      }
      heading.focus();
      for (let step = 0; step < 80 && document.activeElement !== restart; step += 1) await userEvent.tab();
      await expect(restart).toHaveFocus();
      await expect(parseFloat(getComputedStyle(restart).outlineWidth)).toBeGreaterThanOrEqual(2);
      await expect(getComputedStyle(restart).outlineStyle).not.toBe('none');
      const destinations: string[] = [];
      const observe = (event: MouseEvent) => {
        event.preventDefault();
        destinations.push(restart.getAttribute('href')!);
      };
      restart.addEventListener('click', observe);
      try {
        await userEvent.keyboard('{Enter}');
      } finally {
        restart.removeEventListener('click', observe);
      }
      await expect(destinations).toEqual([expected]);
      if (args.enlargedText)
        await expect(parseFloat(getComputedStyle(document.documentElement).fontSize)).toBeGreaterThanOrEqual(32);
      return;
    }
    await expect(view.queryByRole('alert')).toBeNull();
    const emptyPage = ['empty', 'sparse', 'withheld'].includes(args.state);
    if (emptyPage) {
      await expect(view.getByRole('status')).toHaveTextContent(m.subject_relation_empty_page({}, options));
      await expect(region.querySelector('article, [data-slot="relation-group"]')).toBeNull();
      await expect(region).not.toHaveTextContent('Withheld title');
      await expect(region.innerHTML).not.toContain(withheld);
    } else {
      await expect(view.queryByText(m.subject_relation_empty_page({}, options))).toBeNull();
      await expect(region.querySelector('article')).toBeVisible();
    }
    await expect(count?.textContent).toBe(args.state === 'empty' ? '0' : args.state === 'grouped' ? '37' : '37+');
    if (args.state === 'grouped') {
      await expect(
        [...region.querySelectorAll('[data-slot="relation-group"]')].map((group) => group.getAttribute('data-group')),
      ).toEqual(['order', 'derivation', 'world']);
      await expect(region.querySelectorAll('[data-layout="cover-grid"]')).toHaveLength(3);
    }
    if (args.state === 'property') {
      await expect(view.queryByRole('heading', { level: 2 })).toBeNull();
      await expect(region.querySelectorAll('[data-layout="cover-grid"]')).toHaveLength(1);
    }
    if (args.state === 'credit') {
      await expect(view.getByRole('link', { name: 'Role: Principal narrator' })).toHaveAttribute(
        'href',
        `/${locale}/subjects/${role.id}/principal-narrator`,
      );
      await expect(region.querySelector('[lang="ja"]')).toHaveTextContent('朗読者');
      await expect(region.querySelector('a a, a button')).toBeNull();
    }
    if (args.state === 'empty') {
      await expect(next).toBeNull();
      return;
    }
    if (!next) throw new Error('The native continuation anchor is missing');
    const query = new URLSearchParams();
    if (args.state === 'property') query.set('property', 'wdt:P155');
    query.set('cursor', cursor);
    const expected = `/${locale}/subjects/${frame.id}/${slug(frame.title.text)}/relations?${query}`;
    await expect(next).toHaveAttribute('href', expected);
    await expect(next).toBeVisible();
    await expect(next.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(next.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    const style = getComputedStyle(next);
    await expect(style.whiteSpace).toBe('normal');
    await expect(style.overflowWrap).toBe('anywhere');
    await expect(next.scrollWidth).toBeLessThanOrEqual(next.clientWidth + 1);
    await expect(next.scrollHeight).toBeLessThanOrEqual(next.clientHeight + 1);
    await expect(next.getBoundingClientRect().width).toBeLessThanOrEqual(region.clientWidth + 1);
    await expect(next.getBoundingClientRect().left).toBeGreaterThanOrEqual(region.getBoundingClientRect().left - 1);
    await expect(next.getBoundingClientRect().right).toBeLessThanOrEqual(region.getBoundingClientRect().right + 1);
    if (args.longLabels) {
      await expect(next).toHaveTextContent('WeitereBeziehungen'.repeat(16));
      await expect(view.getByRole('link', { name: longTitle })).toBeVisible();
      await expect(style.overflow).not.toBe('hidden');
      await expect(style.textOverflow).not.toBe('ellipsis');
      await expect(next.getBoundingClientRect().height).toBeGreaterThan(parseFloat(style.lineHeight) * 2);
    }
    // Use real Tab navigation; independent card/credit targets precede the separate continuation.
    const controls = [
      ...region.querySelectorAll<HTMLElement>(
        '[data-slot="relation-group"] a[href], [data-slot="relation-group"] button:not([disabled])',
      ),
    ];
    if (controls.length) {
      controls[0]!.focus();
      for (const [index, control] of controls.entries()) {
        if (index) await userEvent.tab();
        await expect(control).toHaveFocus();
      }
    } else heading.focus();
    for (let step = 0; step < 80 && document.activeElement !== next; step += 1) await userEvent.tab();
    await expect(next).toHaveFocus();
    await expect(parseFloat(getComputedStyle(next).outlineWidth)).toBeGreaterThanOrEqual(2);
    await expect(getComputedStyle(next).outlineStyle).not.toBe('none');
    const destinations: string[] = [];
    const observe = (event: MouseEvent) => {
      event.preventDefault();
      destinations.push(next.getAttribute('href')!);
    };
    next.addEventListener('click', observe);
    try {
      await userEvent.keyboard('{Enter}');
    } finally {
      next.removeEventListener('click', observe);
    }
    await expect(destinations).toEqual([expected]);
    if (args.enlargedText)
      await expect(parseFloat(getComputedStyle(document.documentElement).fontSize)).toBeGreaterThanOrEqual(32);
  },
} satisfies Meta<typeof ReadingPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {};
export const Loading: Story = { args: { state: 'loading' }, globals: { viewport: { value: 'phone320' } } };
export const PropertyOnly: Story = { args: { state: 'property' } };
export const TerminalEmpty: Story = { args: { state: 'empty' }, globals: { viewport: { value: 'phone320' } } };
export const SparseEmptyWithNext: Story = { args: { state: 'sparse' }, globals: { viewport: { value: 'phone320' } } };
export const WithheldCurrentPage: Story = { args: { state: 'withheld' } };
export const Unavailable: Story = { args: { state: 'failed' }, globals: { viewport: { value: 'phone320' } } };
export const LongPropertyRecoveryPhone: Story = {
  args: { state: 'failed-property', longLabels: true, direction: 'rtl', enlargedText: true },
  globals: { locale: 'de', viewport: { value: 'phone320' } },
};
export const QualifiedCredit: Story = { args: { state: 'credit' } };
export const LongMultilingualPhone: Story = {
  args: { longLabels: true },
  globals: { locale: 'de', viewport: { value: 'phone320' } },
};
export const LongCreditRtlPhone: Story = {
  args: { state: 'credit', longLabels: true, direction: 'rtl' },
  globals: { locale: 'en', viewport: { value: 'phone320' } },
};
export const EnlargedTextPhone: Story = {
  args: { state: 'credit', longLabels: true, enlargedText: true },
  globals: { locale: 'en', viewport: { value: 'phone320' } },
};
export const SparseTraditionalChinese: Story = {
  args: { state: 'sparse' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone320' } },
};
