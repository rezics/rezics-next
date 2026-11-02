import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import recording from '../kernel/recorded/subject-page.json';
import { AppShell } from '../shell/shell';
import { PatternStory, pagePaths } from './page';

const titles = {
  de: 'Ausgaben, Übersetzungen und Veröffentlichungen in anderen Sprachen und Formaten',
  en: 'Editions, translations and publications in other languages and formats',
  es: 'Ediciones, traducciones y publicaciones en otros idiomas y formatos',
  fr: 'Éditions, traductions et publications dans d’autres langues et formats',
  ja: '異なる言語や形式で出版された版と翻訳および関連する出版物の一覧',
  ko: '다른 언어와 형식으로 출판된 판본과 번역본 및 관련 출판물 목록',
  'zh-Hans': '以其他语言及形式出版的版本、译本和相关出版物完整列表',
  'zh-Hant': '以其他語言及形式出版的版本、譯本與相關出版品完整列表',
};

function overviewPage(failed: boolean, unknownCount: boolean): SubjectPageData {
  const page = structuredClone(recording) as unknown as SubjectPageData;
  const document = page.document as CompositionDocument;
  const editions = document.content.find((node) => node.props.id === 'editions')!;
  // Presentation variants of the recorded default composition; native rows and ordering stay supplied.
  editions.props = { ...editions.props, title: titles, limit: 1 };
  const plan = planReads(platformRegistry, document, { subject: page.subject });
  const key = plan.nodes.editions!;
  if (failed) page.reads[key] = { status: 503, body: { code: 'unavailable' } };
  else if (unknownCount) delete (page.reads[key]!.body as Record<string, unknown>).count;
  return page;
}

function OverviewJourney({
  failed = false,
  unknownCount = false,
  phone = false,
  enlarged = false,
  rtl = false,
}: {
  failed?: boolean;
  unknownCount?: boolean;
  phone?: boolean;
  enlarged?: boolean;
  rtl?: boolean;
}) {
  const [recovered, setRecovered] = useState(false);
  const locale = getLocale();
  const page = overviewPage(failed && !recovered, unknownCount);
  useEffect(() => {
    if (!enlarged) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('font-size');
    const priority = root.style.getPropertyPriority('font-size');
    root.style.setProperty('font-size', '200%');
    return () => {
      if (previous) root.style.setProperty('font-size', previous, priority);
      else root.style.removeProperty('font-size');
    };
  }, [enlarged]);
  return (
    <PatternStory visitor="Signed Out" path={pagePaths.subject}>
      <AppShell>
        <div
          data-slot="overview-navigation-journey"
          dir={rtl ? 'rtl' : undefined}
          style={{ width: phone ? 320 : undefined, maxWidth: '100%' }}
          className="min-w-0"
          onClickCapture={(event) => {
            if (!(event.target instanceof Element) || !event.target.closest('a[data-slot="retry"]')) return;
            // Simulate receiving a fresh page after the ordinary reload anchor is activated.
            // The production component keeps its native href and has no rendering IO.
            event.preventDefault();
            event.stopPropagation();
            setRecovered(true);
          }}
        >
          <SubjectPage
            page={page}
            locale={locale}
            messages={subjectPageMessages()}
            tabs={subjectTabs(page)}
            tabLabels={viewTabLabels()}
          />
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Overview section navigation',
  component: OverviewJourney,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Default Subject Overview with the recorded native composition, finite long localized section labels and a one-row preview. Recovery replaces a supplied failed response after keyboard activation of the native reload link. Phone stories use a 320px content width and 200% root text. Browser, visual and native execution are deferred.',
      },
    },
  },
} satisfies Meta<typeof OverviewJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

function section(canvasElement: HTMLElement): HTMLElement {
  const section = canvasElement.querySelector<HTMLElement>('section#editions');
  if (!section) throw new Error('The default Overview editions section did not render.');
  return section;
}

async function readableAction(canvasElement: HTMLElement, slot: 'see-all' | 'retry') {
  await waitFor(() => expect(canvasElement.querySelector(`section#editions [data-slot="${slot}"]`)).not.toBeNull());
  const region = section(canvasElement);
  const link = region.querySelector<HTMLAnchorElement>(`[data-slot="${slot}"]`)!;
  const heading = within(region).getByRole('heading', { level: 2 });
  await expect(region).toHaveAccessibleName(heading.textContent!);
  await expect(link).toHaveAccessibleName(
    slot === 'retry' ? m.subject_section_retry() : m.subject_view_all({ label: heading.textContent! }),
  );
  const bounds = region.getBoundingClientRect();
  for (const element of [heading, link, ...region.querySelectorAll<HTMLElement>('[data-slot="count"]')]) {
    const box = element.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
    await expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  }
  await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await expect(link.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  await expect(link.querySelector('a, button')).toBeNull();
  return link;
}

async function previewJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  const link = await readableAction(canvasElement, 'see-all');
  const region = section(canvasElement);
  await expect(region.querySelector('[data-slot="count"]')).toHaveTextContent('2');
  await expect(link.getAttribute('href')).toContain('/editions');
  await expect(link).toHaveAttribute('aria-describedby', 'editions-title');
  const rows = region.querySelectorAll('h3');
  // The existing cover adapter has phone and desktop presentations of the same bounded row.
  await expect(new Set(Array.from(rows, (row) => row.textContent)).size).toBe(1);
  let destination: string | null = null;
  link.addEventListener(
    'click',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      destination = link.getAttribute('href');
    },
    { once: true },
  );
  link.focus();
  await expect(link).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(destination).toBe(link.getAttribute('href'));
}

export const Preview: Story = { play: previewJourney };

export const PhoneEnlargedText: Story = {
  args: { phone: true, enlarged: true },
  play: previewJourney,
};

export const PhoneRightToLeft: Story = {
  args: { phone: true, enlarged: true, rtl: true },
  play: previewJourney,
};

export const UnknownCount: Story = {
  args: { phone: true, enlarged: true, unknownCount: true },
  play: async ({ canvasElement }) => {
    await readableAction(canvasElement, 'see-all');
    await expect(section(canvasElement).querySelector('[data-slot="count"]')).toBeNull();
  },
};

export const FailedSectionRecovery: Story = {
  args: { phone: true, enlarged: true, failed: true },
  play: async ({ canvasElement }) => {
    const retry = await readableAction(canvasElement, 'retry');
    const failed = section(canvasElement);
    const sibling = canvasElement.querySelector('section#lists');
    await expect(sibling).not.toBeNull();
    await expect(failed.querySelector('[data-slot="count"], [data-slot="see-all"]')).toBeNull();
    await expect(retry).toHaveAttribute('href', '');
    await expect(retry).toHaveAttribute('aria-describedby', 'editions-title editions-status');
    await expect(retry).toHaveAccessibleDescription(
      `${within(failed).getByRole('heading', { level: 2 }).textContent} ${m.subject_section_failed()}`,
    );
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await readableAction(canvasElement, 'see-all');
    await expect(section(canvasElement).querySelector('[data-slot="retry"], [role="status"]')).toBeNull();
    await expect(canvasElement.querySelector('section#lists')).toBe(sibling);
  },
};
