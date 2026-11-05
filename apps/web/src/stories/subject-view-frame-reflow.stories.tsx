import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { SubjectFrame, SubjectViewPage, subjectFrame } from '../features/pages/subject-frame';
import { SubjectLibraryLeaf } from '../features/pages/subject-library-leaf';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import type { SubjectPageData } from '../features/pages/subject';
import { contextHref } from '../features/pages/context-navigation';
import { qualifiedRealm, qualifiedRelationsPage, qualifiedSubject } from '../kernel/fake/qualified-relations';
import recording from '../kernel/recorded/subject-page.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { WriteReviewAction } from '../subject/write-review';
import { PatternStory } from './page';

const title = 'Donaudampfschifffahrtsgesellschaftskapitän'.repeat(5) + ' — 翻訳された長い題名 / 긴 번역 제목';
const original = '原題のすべてを省略せずに読むための長い題名'.repeat(8);
const rtlOriginal = 'عنوانالعملالأصليالكامل'.repeat(10) + ' — 題名';
const headingSuffix = 'AusgabenUndVeröffentlichungsgeschichte'.repeat(5) + ' / 関連する作品と資料';
const signedOut = { state: 'signed-out', subject: null, csrfToken: null } as const;

type ExampleProps = {
  streams: 'none' | 'one' | 'many';
  realm: boolean;
  missing: boolean;
  largeText: boolean;
  rtl: boolean;
  actionSession: 'signed-out' | 'unavailable';
  longStreamTitle: boolean;
};

/** Only the existing supplied fixture bodies are used; these samples establish no native access or read outcome. */
function CompanionPage({ streams, realm, missing, largeText, rtl, actionSession, longStreamTitle }: ExampleProps) {
  const locale = getLocale();
  useEffect(() => {
    if (!largeText) return;
    const root = document.documentElement;
    const previous = root.style.fontSize;
    root.style.fontSize = '200%';
    return () => {
      root.style.fontSize = previous;
    };
  }, [largeText]);
  const page = qualifiedRelationsPage(realm ? { realm: qualifiedRealm } : {});
  if (realm) page.requestedRealm = qualifiedRealm;
  if (streams === 'one')
    page.document.content = page.document.content.filter((node) => ['SubjectHeader', 'Credits'].includes(node.type));
  if (streams === 'none')
    page.document.content = page.document.content.map((node) => ({ ...node, props: { ...node.props, paged: false } }));
  if (longStreamTitle)
    page.document.content = page.document.content.map((node) =>
      node.type === 'Credits' ? { ...node, props: { ...node.props, title: { de: headingSuffix } } } : node,
    );
  const identity = subjectFrame(page, locale)!;
  const date = subjectFrame(recording as unknown as SubjectPageData, locale)?.date;
  const frame = {
    ...identity,
    title: missing ? { text: '' } : { text: title, lang: 'de' },
    ...(!missing ? { original: { text: rtl ? rtlOriginal : original, lang: rtl ? 'ar' : 'ja' } } : {}),
    ...(date ? { date } : {}),
  };
  const base = subjectHref(qualifiedSubject, locale).href;
  const nextHref = `${base}/credits?node=cast&cursor=cast-next${realm ? `&realm=${qualifiedRealm}` : ''}`;
  const current = contextHref(`${base}/credits`, realm ? qualifiedRealm : undefined);
  const label = `${m.subject_credits()} / ${headingSuffix}`;
  return (
    <PatternStory visitor="Signed Out" path={current}>
      <main
        data-slot="companion-page-sample"
        dir={rtl ? 'rtl' : 'ltr'}
        className="mx-auto min-w-0 px-6 py-6"
        style={{ width: 320, maxWidth: '100%' }}
      >
        <SubjectViewPage
          page={page}
          subjectLabel={frame.title.text}
          locale={locale}
          messages={subjectPageMessages()}
          link={SubjectLink}
          view="credits"
          label={label}
          nextHref={nextHref}
          renderJsonLd={false}
          actions={
            <WriteReviewAction
              subjectId={frame.id}
              subjectTitle={frame.title.text}
              locale={locale}
              session={actionSession}
            />
          }
          frame={
            <SubjectFrame
              frame={frame}
              locale={locale}
              link={SubjectLink}
              realm={realm ? qualifiedRealm : undefined}
              unlabelled={m.subject_value_unlabelled()}
              coverLabels={{
                withheld: m.subject_cover_withheld(),
                reveal: m.subject_cover_reveal(),
                credit: m.subject_cover_credit(),
                via: m.subject_cover_via(),
              }}
              tabs={subjectTabs(page)}
              tabLabels={viewTabLabels()}
              view="credits"
              library={<SubjectLibraryLeaf frame={frame} locale={locale} session={signedOut} />}
            />
          }
        />
      </main>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Companion view reflow',
  component: CompanionPage,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Whole 320px companion compositions mount SubjectFrame, SubjectViewPage, real tabs, the shared signed-out Library leaf and WriteReviewAction. Existing qualified-relations fixture bodies supply rows and cursors; changing only paged presentation flags exercises the fallback. Long identity/heading values are supplied display stress inputs. LargeText doubles the document root text size. A single stream owns h1; groups remain h2 beneath the page heading. Plays cover layout, keyboard focus and exact destinations without invoking readers or continuation callbacks. Browser, native and visual acceptance remain deferred.',
      },
    },
  },
  args: {
    streams: 'none',
    realm: true,
    missing: false,
    largeText: false,
    rtl: false,
    actionSession: 'signed-out',
    longStreamTitle: false,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const main = canvasElement.querySelector<HTMLElement>('[data-slot="companion-page-sample"]')!;
    const header = main.querySelector<HTMLElement>('[data-slot="subject-header"]')!;
    const titleLink = header.querySelector<HTMLAnchorElement>('a')!;
    const library = main.querySelector<HTMLElement>('[data-slot="subject-library"]')!;
    const libraryLink = await within(library).findByRole('link', { name: m.account_sign_in() });
    const tabs = main.querySelector<HTMLElement>('[data-slot="view-tabs"]')!;
    const active = tabs.querySelector<HTMLAnchorElement>('[aria-current="page"]')!;
    const locale = getLocale();
    const base = subjectHref(qualifiedSubject, locale).href;
    const selectedRealm = args.realm ? qualifiedRealm : undefined;
    const nativeNext = `${base}/credits?node=cast&cursor=cast-next${args.realm ? `&realm=${qualifiedRealm}` : ''}`;
    const frameBase = subjectHref({ id: qualifiedSubject.id, label: args.missing ? '' : title }, locale).href;
    await expect(titleLink).toHaveTextContent(args.missing ? m.subject_value_unlabelled() : title);
    await expect(titleLink).toHaveAttribute('href', contextHref(frameBase, selectedRealm));
    if (!args.missing) {
      await expect(titleLink).toHaveAttribute('lang', 'de');
      const originalTitle = header.querySelector<HTMLElement>(args.rtl ? '[lang="ar"]' : '[lang="ja"]')!;
      await expect(originalTitle.textContent).toBe(args.rtl ? rtlOriginal : original);
      await expect(originalTitle.scrollWidth).toBeLessThanOrEqual(originalTitle.clientWidth + 1);
    } else {
      await expect(header.querySelector('[lang="ja"], [lang="ar"]')).toBeNull();
    }
    await expect(header.querySelector('[data-slot="cover"]')).toHaveAttribute('data-size', 'xs');
    const cover = header.querySelector<HTMLElement>('[data-slot="cover"]')!;
    await expect(cover.getBoundingClientRect().width).toBe(48);
    await expect(cover).toHaveAttribute('data-ratio', '5:7');
    await expect(cover).toHaveAttribute('data-state', 'placeholder');
    await expect(library.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(tabs.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    await expect(active).toHaveAttribute('href', contextHref(`${frameBase}/credits`, selectedRealm));
    await expect(tabs.querySelector('[role="tab"]')).toBeNull();
    await expect(header.querySelector('[data-slot="subject-contribute"]') !== null).toBe(!args.realm);
    const fallback = main.querySelector<HTMLAnchorElement>('[data-slot="next-page"]');
    const groupLinks = [...main.querySelectorAll<HTMLAnchorElement>('[data-slot="continue-group"]')];
    if (args.streams === 'none') {
      await expect(canvas.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      const heading = canvas.getByRole('heading', { level: 1 });
      await expect(heading.textContent).toBe(`${m.subject_credits()} / ${headingSuffix}`);
      await expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth + 1);
      await expect(fallback).toHaveAttribute('href', nativeNext);
      await expect(fallback!.textContent).toBe(
        m.subject_view_continue({ label: `${m.subject_credits()} / ${headingSuffix}` }),
      );
      await expect(groupLinks).toHaveLength(0);
    } else {
      await expect(fallback).toBeNull();
      await expect(groupLinks).toHaveLength(args.streams === 'one' ? 1 : 3);
      for (const link of groupLinks) {
        const node = link.closest('[data-node]')!.getAttribute('data-node')!;
        const view = node === 'cast' ? 'credits' : 'relations';
        await expect(link).toHaveAttribute(
          'href',
          `${base}/${view}?node=${node}&cursor=${node}-next${args.realm ? `&realm=${qualifiedRealm}` : ''}`,
        );
      }
      await expect(canvas.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      const streamTitle = args.longStreamTitle ? headingSuffix : 'Cast';
      await expect(canvas.getAllByRole('heading', { name: streamTitle })).toHaveLength(1);
      const streamHeading = canvas.getByRole('heading', { name: streamTitle });
      await expect(streamHeading).toHaveProperty('tagName', args.streams === 'one' ? 'H1' : 'H2');
      await expect(streamHeading.scrollWidth).toBeLessThanOrEqual(streamHeading.clientWidth + 1);
      if (args.longStreamTitle) await expect(streamHeading).toHaveAttribute('lang', 'de');
    }
    const action = canvas.queryByRole('link', { name: m.thread_review_sign_in() });
    if (args.actionSession === 'signed-out') {
      await expect(action).toHaveAttribute(
        'href',
        `/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/subjects/${qualifiedSubject.id}/reviews`)}`,
      );
    } else await expect(action).toBeNull();
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    await expect(titleLink.scrollWidth).toBeLessThanOrEqual(titleLink.clientWidth + 1);
    await expect(libraryLink).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(contextHref(`${base}/credits`, selectedRealm))}`,
    );
    const targets = [
      titleLink,
      libraryLink,
      active,
      ...(action ? [action] : []),
      ...(fallback ? [fallback] : groupLinks),
    ];
    for (const target of targets) {
      await expect(target.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      await expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      for (let step = 0; step < 100 && target.ownerDocument.activeElement !== target; step++) await userEvent.tab();
      await expect(target).toHaveFocus();
      const style = getComputedStyle(target);
      await expect(
        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none',
      ).toBe(true);
    }
  },
} satisfies Meta<typeof CompanionPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PhoneFallback: Story = {};
export const PhoneLargeText: Story = { args: { largeText: true } };
export const PhoneRtl: Story = { args: { rtl: true } };
export const MissingLabelAndCover: Story = { args: { missing: true, actionSession: 'unavailable' } };
export const GlobalActions: Story = { args: { realm: false } };
export const StreamOwned: Story = { args: { streams: 'one' } };
export const MultipleStreamGroups: Story = { args: { streams: 'many' } };
export const StreamOwnedLargeText: Story = { args: { streams: 'one', largeText: true, longStreamTitle: true } };
