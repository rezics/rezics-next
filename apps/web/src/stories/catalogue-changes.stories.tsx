import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { SubjectChanges, SubjectChangesPage } from '../features/catalogue/subject-changes-page';
import { catalogueChangesFixture, type ChangesScenario } from '../kernel/fake/catalogue-changes';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { pageText } from '../features/pages/shared';
import { sourceDefinitions } from '../kernel/fake/catalogue-sources';
import { languageName } from '../subject/language';

/** Isolated presentation samples use the delivered terms field/language structure, without native proof. */
function ChangesStory({
  scenario = 'ready',
  limited = false,
  detailLoading = false,
}: {
  scenario?: ChangesScenario;
  limited?: boolean;
  detailLoading?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(
    () =>
      catalogueChangesFixture(scenario, locale, async (_client, input) =>
        detailLoading
          ? new Promise(() => {})
          : {
              kind: 'ready',
              detail: {
                id: input.id,
                revision: input.revision,
                ...(input.revision !== 2 && !limited
                  ? { propertyLabel: pageText(sourceDefinitions.properties['schema:datePublished']?.labels, locale) }
                  : {}),
                summary: limited
                  ? { kind: 'limited' }
                  : input.revision === 2
                    ? {
                        kind: 'terms',
                        fields: [
                          { field: 'labels', languages: ['fr'] },
                          { field: 'descriptions', languages: ['en'] },
                        ],
                      }
                    : {
                        kind: 'candidate',
                        candidate: '00000000-0000-8000-8000-000000000005',
                        property: 'schema:datePublished',
                      },
              },
            },
      ),
    [scenario, locale, limited, detailLoading],
  );
  const transport = useMemo(
    () => ({
      ...fixture.transport,
      list: async (...args: Parameters<typeof fixture.transport.list>) => {
        const result = await fixture.transport.list(...args);
        if (result.kind !== 'ready') fixture.recover();
        return result;
      },
      detail: async (...args: Parameters<typeof fixture.transport.detail>) => {
        const result = await fixture.transport.detail(...args);
        fixture.recover();
        return result;
      },
    }),
    [fixture],
  );
  return (
    <PatternStory path="/" visitor="Signed Out">
      <AppShell>
        <SubjectChanges
          key={`${locale}:${scenario}:${limited}:${detailLoading}`}
          locale={locale}
          transport={transport}
          currentHref={`/${locale}/subjects/${fixture.id}`}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Changes',
  id: 'pages-catalogue-changes',
  component: ChangesStory,
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <ChangesStory key={`${getLocale()}:${args.scenario}:${args.limited}:${args.detailLoading}`} {...args} />
  ),
} satisfies Meta<typeof ChangesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const select = async (canvasElement: HTMLElement, revision: number) => {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole('button', { name: new RegExp(m.changes_revision({ revision: String(revision) })) }),
  );
  return canvas;
};
export const Revisions: Story = {};
export const ContinueAndExplain: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: actual Changes continuation, revision selection and current-reading link target/text geometry at phone390. Browser, visual and native verification are deferred. The same story supports desktop1280 through the viewport global.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const revisions = within(await canvas.findByRole('region', { name: m.changes_revisions() }));
    const document = canvasElement.ownerDocument;
    const page = canvas.getByRole('article');
    const minimum = document.defaultView!.matchMedia('(max-width: 767px), (pointer: coarse)').matches ? 44 : 32;
    const contained = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      const pageBounds = page.getBoundingClientRect();
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      expect(bounds.left).toBeGreaterThanOrEqual(Math.max(0, pageBounds.left) - 1);
      expect(bounds.right).toBeLessThanOrEqual(Math.min(document.documentElement.clientWidth, pageBounds.right) + 1);
    };
    const targets = () => {
      contained(page);
      for (const target of [
        ...revisions.getAllByRole('button'),
        canvas.getByRole('link', { name: m.changes_current() }),
      ]) {
        contained(target);
        const bounds = target.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThanOrEqual(minimum);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        const text = document.createTreeWalker(target, 4 /* SHOW_TEXT */);
        while (text.nextNode()) {
          if (!text.currentNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text.currentNode);
          for (const line of range.getClientRects()) {
            expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
            expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
            expect(line.top).toBeGreaterThanOrEqual(bounds.top - 1);
            expect(line.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
          }
        }
      }
    };
    targets();
    await userEvent.click(await revisions.findByRole('button', { name: m.changes_more() }));
    await waitFor(() => expect(revisions.getByRole('button', { name: m.changes_more() })).toBeEnabled());
    expect(revisions.getAllByRole('listitem')).toHaveLength(2);
    expect(revisions.getByText(m.changes_proposal())).toBeTruthy();
    expect(revisions.getByText(m.changes_acceptance())).toBeTruthy();
    targets();
    await userEvent.click(await revisions.findByRole('button', { name: m.changes_more() }));
    const revision = await revisions.findByRole('button', {
      name: new RegExp(m.changes_revision({ revision: '2' })),
    });
    expect(within(revision).getByText(m.changes_recorded())).toBeTruthy();
    expect(within(revision).queryByText(m.changes_adoption())).toBeNull();
    expect(revisions.getAllByRole('listitem')).toHaveLength(3);
    expect(revisions.queryByRole('button', { name: m.changes_more() })).toBeNull();
    targets();
    await userEvent.click(revision);
    const detail = within(await canvas.findByRole('region', { name: m.changes_revision({ revision: '2' }) }));
    expect(await detail.findByText(m.changes_terms())).toBeTruthy();
    expect(revision).toHaveAttribute('aria-pressed', 'true');
    const fields = within(detail.getByLabelText(m.changes_fields()));
    expect(within(fields.getByText(m.changes_name()).parentElement!).getByRole('definition')).toHaveTextContent(
      languageName('fr', getLocale())!,
    );
    expect(within(fields.getByText(m.changes_description()).parentElement!).getByRole('definition')).toHaveTextContent(
      languageName('en', getLocale())!,
    );
    expect(detail.getByText(m.changes_current_notice())).toBeTruthy();
    expect(canvas.getByRole('link', { name: m.changes_current() }).getAttribute('href')).toContain('/subjects/');
    contained(canvas.getByRole('region', { name: m.changes_revision({ revision: '2' }) }));
    targets();
  },
};
export const Proposal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    expect(await canvas.findByText(m.changes_proposal_detail())).toBeTruthy();
  },
};
export const LimitedSafeDetail: Story = {
  args: { limited: true },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    expect(await canvas.findByText(m.changes_limited())).toBeTruthy();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const Conflict: Story = { args: { scenario: 'conflict' } };
export const Concealed: Story = { args: { scenario: 'missing' } };
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.changes_retry() }));
    expect(await canvas.findByRole('heading', { name: m.changes_revisions() })).toBeTruthy();
  },
};
export const DetailRetry: Story = {
  args: { scenario: 'detail-retry' },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    await userEvent.click(await canvas.findByRole('button', { name: m.changes_retry_detail() }));
    expect(await canvas.findByText(m.changes_proposal_detail())).toBeTruthy();
  },
};

export const DetailLoading: Story = {
  args: { detailLoading: true },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    expect(await canvas.findByText(m.changes_detail_loading())).toBeTruthy();
  },
};

/** Supplied presentation data only; this does not replace the native fixture's unavailable detail. */
export const CurrentReading: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: a recorded proposal with an actual current reading supplied to the page. Mounted, browser and native proof are deferred.',
      },
    },
  },
  render: () => {
    const locale = getLocale();
    const { id, read } = catalogueChangesFixture();
    return (
      <PatternStory path="/" visitor="Signed Out">
        <AppShell>
          <SubjectChangesPage
            locale={locale}
            state={{
              page: {
                id,
                title: pageText(read.subject.labels, locale),
                typeLabel: pageText(sourceDefinitions.types[read.subject.type]?.labels, locale),
                href: `/${locale}/subjects/${id}`,
                revisions: [{ revision: 5, kind: 'propose' }],
                next: null,
              },
              selected: 5,
              detail: {
                kind: 'ready',
                detail: {
                  id,
                  revision: 5,
                  propertyLabel: pageText(sourceDefinitions.properties['schema:datePublished']?.labels, locale),
                  summary: {
                    kind: 'candidate',
                    candidate: '00000000-0000-8000-8000-000000000005',
                    property: 'schema:datePublished',
                    reading: {
                      decision: { head: 8, verdict: 'accept', revision: 6 },
                      selected: true,
                      rank: 'preferred',
                    },
                  },
                },
              },
            }}
          />
        </AppShell>
      </PatternStory>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const current = within(canvas.getByRole('region', { name: m.changes_current() }));
    await expect(current.getByText(m.context_accepted())).toBeVisible();
    await expect(current.getByText(m.context_selected())).toBeVisible();
    await expect(current.getByText(new RegExp(m.candidate_rank_preferred()))).toBeVisible();
    expect(canvas.queryByText(m.changes_current_notice())).toBeNull();
  },
};

export const LimitedEvidence: Story = {
  args: { limited: true },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: limited revision detail keeps its incomplete-evidence notice and the actual current-reading link. Mounted, browser and native proof are deferred.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    await expect(await canvas.findByText(m.changes_limited())).toBeVisible();
    await expect(canvas.getByText(m.changes_current_notice())).toBeVisible();
    expect(canvas.queryByRole('region', { name: m.changes_current() })).toBeNull();
    expect(canvas.getByRole('link', { name: m.changes_current() }).getAttribute('href')).toContain('/subjects/');
  },
};

/** UNRUN: supplied bounded native-shaped responses; no backend, SSR or geometry proof is claimed. */
function IndependentHistoryFamily({ rtl = false }: { rtl?: boolean }) {
  const locale = getLocale();
  const fixtures = useMemo(
    () =>
      [0, 1].map((index) => {
        const fixture = catalogueChangesFixture('ready', locale, undefined, (revision) =>
          Response.json({
            subject: fixture.id,
            revision: { revision, kind: revision === 2 ? 'terms' : 'propose', release: fixture.read.subject.release },
            change:
              revision === 2
                ? {
                    kind: 'terms',
                    fields: [
                      { field: 'labels', languages: ['en', 'fr', 'de', 'ja', 'ko', 'zh-Hant', 'zh-Hans', 'es'] },
                      { field: 'descriptions', languages: ['ja', 'de', 'fr'] },
                      { field: 'aliases', languages: ['es', 'en', 'ko'] },
                    ],
                  }
                : {
                    kind: 'candidate',
                    candidate: '00000000-0000-8000-8000-000000000005',
                    property: 'schema:datePublished',
                    context: fixture.read.subject.context,
                    reading: {
                      decision: { head: 8, verdict: 'accept', revision: 6 },
                      selected: true,
                      rank: 'preferred',
                    },
                  },
          }),
        );
        fixture.read.subject.labels[locale] =
          `${index + 1} · 星の旅 — Édition originale — رحلة طويلة ${'A complete supplied catalogue title '.repeat(8)}`;
        return fixture;
      }),
    [locale],
  );
  return (
    <PatternStory path="/" visitor="Signed Out">
      <AppShell>
        <div dir={rtl ? 'rtl' : 'ltr'} className="grid min-w-0 gap-12">
          {fixtures.map((fixture, index) => (
            <SubjectChanges key={index} locale={locale} transport={fixture.transport} />
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}

// Real browser assertions are authored only. DOM-only tests below do not substitute for them.
function assertHistoryGeometry(page: HTMLElement) {
  const document = page.ownerDocument;
  const contained = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
    const walker = document.createTreeWalker(element, 4);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
        expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
      }
    }
  };
  contained(page);
  for (const target of [...page.querySelectorAll<HTMLElement>('button, a')].filter(
    (node) =>
      (node.tagName === 'BUTTON' && !node.closest('[data-slot="subject-frame"]')) ||
      node.textContent === m.changes_current(),
  )) {
    contained(target);
    const bounds = target.getBoundingClientRect();
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
  for (const evidence of page.querySelectorAll<HTMLElement>('section, dl, dt, dd')) contained(evidence);
}

export const IndependentHistoryPhone: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: two actual history readers, own h2 associations, native keyboard selection, sparse continuation, current versus historical evidence and 44px controls with fully wrapping multilingual text. Supports all launch locales; no native authority or visual result is claimed.',
      },
    },
  },
  render: () => <IndependentHistoryFamily />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole('region', { name: m.changes_revisions() })).toHaveLength(2));
    const pages = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="subject-changes"]')];
    const ids = pages.map((page) => page.querySelector('section[aria-labelledby]')!.getAttribute('aria-labelledby')!);
    expect(new Set(ids).size).toBe(2);
    for (const [index, page] of pages.entries()) {
      const own = within(page);
      const heading = page.ownerDocument.getElementById(ids[index]!);
      expect(page.contains(heading)).toBe(true);
      expect(heading?.tagName).toBe('H2');
      const current = own.getByRole('link', { name: m.changes_current() });
      current.focus();
      await userEvent.tab();
      const first = own.getByRole('button', { name: new RegExp(m.changes_revision({ revision: '5' })) });
      expect(first).toHaveFocus();
      expect(first.matches(':focus-visible')).toBe(true);
      await userEvent.keyboard('{Enter}');
      const reading = within(await own.findByRole('region', { name: m.changes_current() }));
      expect(reading.getByText(m.context_accepted())).toBeVisible();
      expect(reading.getByText(m.context_selected())).toBeVisible();
      expect(reading.getByText(new RegExp(m.candidate_rank_preferred()))).toBeVisible();
      expect(first).toHaveAttribute('aria-pressed', 'true');
      expect(own.queryByText(m.changes_current_notice())).toBeNull();
      assertHistoryGeometry(page);
      const revisions = within(own.getByRole('region', { name: m.changes_revisions() }));
      await userEvent.click(revisions.getByRole('button', { name: m.changes_more() }));
      await waitFor(() => expect(revisions.getByRole('button', { name: m.changes_more() })).toBeEnabled());
      expect(revisions.getAllByRole('listitem')).toHaveLength(2);
      await userEvent.click(revisions.getByRole('button', { name: m.changes_more() }));
      const terms = await revisions.findByRole('button', { name: new RegExp(m.changes_revision({ revision: '2' })) });
      terms.focus();
      await userEvent.keyboard(' ');
      const fields = await own.findByLabelText(m.changes_fields());
      expect(fields.querySelectorAll('dt')).toHaveLength(3);
      for (const term of fields.querySelectorAll('dt')) {
        expect(term.nextElementSibling?.tagName).toBe('DD');
        expect(term.nextElementSibling?.textContent?.length).toBeGreaterThan(0);
      }
      expect(revisions.getAllByRole('listitem')).toHaveLength(3);
      expect(own.getByText(m.changes_current_notice())).toBeVisible();
      expect(own.queryByRole('region', { name: m.changes_current() })).toBeNull();
      expect(page.querySelector('section[aria-labelledby]')?.getAttribute('aria-labelledby')).toBe(ids[index]);
      assertHistoryGeometry(page);
    }
  },
};

export const IndependentHistoryDesktop: Story = {
  ...IndependentHistoryPhone,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};

export const IndependentHistoryRtl: Story = {
  ...IndependentHistoryPhone,
  render: () => <IndependentHistoryFamily rtl />,
};

/** Explicit supplied presentation evidence; the original connected/native witnesses remain unchanged. */
export const LongRevisionCurrentAndFields: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: full long revision/property evidence, all three terms fields, independent current/historical regions and 44px current links at phone390. Select desktop1280 and any launch locale for the same authored geometry assertions. These supplied snapshots perform no reads.',
      },
    },
  },
  render: () => {
    const locale = getLocale();
    const fixture = catalogueChangesFixture();
    const revision = 2147483647;
    const page = {
      id: fixture.id,
      title: { text: `星の旅 — رحلة طويلة ${'Complete supplied title '.repeat(12)}`, lang: 'en' },
      typeLabel: pageText(sourceDefinitions.types[fixture.read.subject.type]?.labels, locale),
      href: `/${locale}/subjects/${fixture.id}`,
      revisions: [{ revision, kind: 'terms' }],
      next: null,
    };
    const common = {
      id: fixture.id,
      revision,
      propertyLabel: { text: `A full supplied property label ${'星 Édition رحلة '.repeat(32)}`, lang: 'en' },
    };
    return (
      <PatternStory path="/" visitor="Signed Out">
        <AppShell>
          <div dir="rtl" className="grid min-w-0 gap-12">
            <SubjectChangesPage
              locale={locale}
              state={{
                page,
                selected: revision,
                detail: {
                  kind: 'ready',
                  detail: {
                    ...common,
                    summary: {
                      kind: 'candidate',
                      candidate: '00000000-0000-8000-8000-000000000005',
                      property: 'schema:isbn',
                      reading: {
                        decision: { head: 8, verdict: 'accept', revision: 6 },
                        selected: true,
                        rank: 'preferred',
                      },
                    },
                  },
                },
              }}
            />
            <SubjectChangesPage
              locale={locale}
              state={{
                page,
                selected: revision,
                detail: {
                  kind: 'ready',
                  detail: {
                    ...common,
                    summary: {
                      kind: 'terms',
                      fields: [
                        { field: 'labels', languages: ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] },
                        { field: 'descriptions', languages: ['ja', 'de', 'fr'] },
                        { field: 'aliases', languages: ['es', 'en', 'ko'] },
                      ],
                    },
                  },
                },
              }}
            />
          </div>
        </AppShell>
      </PatternStory>
    );
  },
  play: async ({ canvasElement }) => {
    const pages = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="subject-changes"]')];
    expect(pages).toHaveLength(2);
    const ids = pages.map((page) => page.querySelector('section[aria-labelledby]')!.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
    for (const page of pages) {
      assertHistoryGeometry(page);
      const current = within(page).getByRole('link', { name: m.changes_current() });
      current.focus();
      expect(current).toHaveFocus();
      expect(current.getAttribute('href')).toContain('/subjects/');
      expect(page.textContent).toContain('A full supplied property label');
      expect(
        within(page).getByRole('heading', { name: m.changes_revision({ revision: '2147483647' }) }),
      ).toHaveProperty('tagName', 'H2');
    }
    const reading = within(within(pages[0]!).getByRole('region', { name: m.changes_current() }));
    expect(reading.getByText(m.context_selected())).toBeVisible();
    expect(reading.getByText(new RegExp(m.candidate_rank_preferred()))).toBeVisible();
    const fields = within(pages[1]!).getByLabelText(m.changes_fields());
    expect(fields.querySelectorAll('dt')).toHaveLength(3);
    const labels = [m.changes_name(), m.changes_description(), m.changes_aliases()];
    for (const [index, term] of [...fields.querySelectorAll('dt')].entries()) {
      expect(term.textContent).toBe(labels[index]);
      expect(term.nextElementSibling?.tagName).toBe('DD');
      expect(term.nextElementSibling).toBeVisible();
    }
    expect(within(pages[1]!).getByText(m.changes_current_notice())).toBeVisible();
  },
};

export const IndependentHistoryDesktopRtl: Story = {
  ...IndependentHistoryDesktop,
  render: () => <IndependentHistoryFamily rtl />,
};

export const LongRevisionCurrentAndFieldsDesktop: Story = {
  ...LongRevisionCurrentAndFields,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
