import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, PatternStory, libraryCollectionReady, pagePaths, pageReady } from './page';
import { pickText } from '@rezics/composition';
import { defaultCoverRatio, parseListPresentation } from '@rezics/ui/cover';
import { CollectionReadMembers } from '../library/collection-page';
import { subjectOf, type CollectionMember } from '../library/reads';
import { getLocale } from '../paraglide/runtime.js';
import memberRecording from '../kernel/recorded/library-collection-members.json';
import subjectRecording from '../kernel/recorded/subject.json';
import definitionsRecording from '../kernel/recorded/definitions-release.json';
import { collectionStoryMembers, collectionStoryPaths } from '../kernel/fake/collection-stories';
import { collectionLongNotesSparse, setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { collectionReadStoryIds } from '../kernel/fake/collection-read-stories';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Collection',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Read page states. Review these same IDs at phone390 and desktop1280, all launch locale globals and light/dark theme globals. UnlistedVisitor is a required signed-out unlisted browse state. LongNotesSparseContinuation joins long mixed-script identity, document-derived notes, duplicate occurrences and continuable empty slices. Overflow, keyboard and target-size remain unmeasured until admitted capture; canonical IDs come from the admitted index. Web story review and Root screenshot review PENDING. Social actions await their native producers; rows render only supplied FULL facts.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const variants = {
  CuratorPublicMany: {
    id: collectionStoryPaths.curatorPublicMany,
    title: 'A curator’s reading shelf',
    visitor: 'Signed In',
  },
  ReaderPublicMany: {
    id: collectionStoryPaths.readerPublicMany,
    title: 'A reader’s reading shelf',
    visitor: 'Signed Out',
    memberCount: 4,
  },
  CuratorPrivateEmpty: {
    id: collectionStoryPaths.curatorPrivateEmpty,
    title: 'A private empty shelf',
    visitor: 'Signed In',
  },
  ReaderPrivate: {
    id: collectionStoryPaths.readerPrivate,
    title: null,
    visitor: 'Signed Out',
  },
  CuratorPublicOnePage: {
    id: collectionStoryPaths.curatorPublicOnePage,
    title: 'A one-page shelf',
    visitor: 'Signed In',
  },
} as const;

async function variantReady(context: { canvasElement: HTMLElement }, title: string | null) {
  await pageReady(context);
  if (title)
    await within(context.canvasElement).findByRole('heading', {
      level: 1,
      name: title,
    });
}

async function menuForTrigger(trigger: HTMLElement) {
  const view = trigger.ownerDocument.defaultView!;
  const sheet = view.matchMedia('(max-width: 767px)').matches || view.matchMedia('(pointer: coarse)').matches;
  const panel = await waitFor(() => {
    if (sheet) {
      const dialog = within(trigger.ownerDocument.body).getByRole('dialog', { name: m.library_collection_actions() });
      expect(dialog).toBeVisible();
      return dialog;
    }
    const controlledId = trigger.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    const menu = trigger.ownerDocument.getElementById(controlledId!);
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAttribute('aria-labelledby', trigger.id);
    expect(menu).toBeVisible();
    return menu!;
  });
  return within(panel);
}

async function collectionReadyWithHover(context: { canvasElement: HTMLElement }) {
  await libraryCollectionReady(context);
  const member = context.canvasElement.querySelector('[data-slot="collection-member-card"], [data-slot="list-row"]');
  if (member) await userEvent.hover(member);
}

async function bookRowFactsReady(context: { canvasElement: HTMLElement }) {
  const locale = getLocale();
  const type = pickText(definitionsRecording.release.types['schema:Book'].labels, locale).text;
  for (const member of collectionStoryMembers) {
    const link = await within(context.canvasElement).findByRole('link', { name: member.subject.label.value });
    const row = link.closest('[data-slot="list-row"], [data-slot="collection-member-card"]')!;
    await expect(within(row as HTMLElement).getByText(type, { exact: true })).toBeVisible();
    const details = row.querySelector('[data-slot="member-list-row-facts"]');
    await expect(details).toBeVisible();
    const facts = within(details as HTMLElement);
    const author = member.facts['schema:author']![0]!;
    if (author.kind === 'item')
      await expect(facts.getByText(pickText(author.labels, locale).text, { exact: true })).toBeVisible();
    const publication = member.facts['schema:datePublished']?.[0];
    if (publication?.kind === 'time')
      await expect(
        facts.getByText(new Intl.NumberFormat(locale, { useGrouping: false }).format(publication.year), {
          exact: true,
        }),
      ).toBeVisible();
    const image = row.querySelector('img');
    if (member.subject.cover)
      await expect(image).toHaveAttribute('src', expect.stringContaining(member.subject.cover.media));
    else await expect(image).toBeNull();
  }
}

async function compactCollectionReady(context: { canvasElement: HTMLElement }) {
  await collectionReadyWithHover(context);
  await bookRowFactsReady(context);
  const canvas = within(context.canvasElement);
  await expect(canvas.queryByRole('button', { name: m.reaction_like() })).toBeNull();
  await expect(canvas.queryByRole('button', { name: m.library_subject_save() })).toBeNull();
  await expect(canvas.queryByText(m.library_collection_social_unavailable())).toBeNull();
  await expect(canvas.queryByText(m.library_collection_kind_pending())).toBeNull();
  await expect(canvas.queryByRole('button', { name: new RegExp(m.library_nav_selector()) })).toBeNull();
  const hero = context.canvasElement.querySelector<HTMLElement>('[data-slot="collection-hero"]');
  const toolbar = context.canvasElement.querySelector<HTMLElement>('[data-slot="collection-toolbar"]');
  await expect(hero).toBeVisible();
  const identityCover = hero!.querySelector('[data-slot="cover"]');
  await expect(identityCover).toHaveAttribute('data-state', 'placeholder');
  await expect(identityCover).toHaveAttribute('data-ratio', defaultCoverRatio);
  await expect(identityCover!.querySelector('[data-slot="cover-placeholder-title"]')).toHaveTextContent(
    'Books I come back to',
  );
  await expect(identityCover!.querySelector('img')).toBeNull();
  await expect(toolbar).toBeVisible();
  const view = context.canvasElement.ownerDocument.defaultView!;
  if (view.innerWidth === 390) {
    const member = context.canvasElement.querySelector<HTMLElement>('[data-collection-members] [data-slot="list-row"]');
    await expect(member).toBeVisible();
    expect(hero!.getBoundingClientRect().height).toBeLessThanOrEqual(view.innerHeight * 0.55);
    expect(member!.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.innerHeight);
    const filter = within(toolbar!).getByRole('button', { name: m.collection_filters() }).getBoundingClientRect();
    for (const link of within(toolbar!).getAllByRole('link')) {
      const rect = link.getBoundingClientRect();
      expect(Math.abs(rect.top + rect.height / 2 - filter.top - filter.height / 2)).toBeLessThanOrEqual(1);
    }
    expect(context.canvasElement.scrollWidth).toBeLessThanOrEqual(view.innerWidth);
  }
}

function variantStory(variant: (typeof variants)[keyof typeof variants]): Story {
  return {
    play: (context) => variantReady(context, variant.title),
    render: () => <PageStory visitor={variant.visitor} path={`/collections/${variant.id}`} />,
  };
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: compactCollectionReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-collection']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: libraryCollectionReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-collection']} />,
};
export const PublicItemListExport: Story = {
  name: 'Public ItemList export',
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-collection']} />,
  play: async (context) => {
    await libraryCollectionReady(context);
    const document = context.canvasElement.ownerDocument;
    await waitFor(() => {
      const script = document.querySelector('script[type="application/ld+json"]');
      expect(script).not.toBeNull();
      const itemList = JSON.parse(script?.textContent ?? 'null') as {
        '@context'?: string;
        '@type'?: string;
        itemListElement?: unknown[];
      };
      expect(itemList).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
      });
      expect(itemList.itemListElement).toHaveLength(4);
      expect(JSON.stringify(itemList)).not.toMatch(/private|visibility|revision|curatorAccountId/i);
    });
    const canvas = within(context.canvasElement);
    const graph = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(
        (script) =>
          JSON.parse(script.textContent ?? 'null') as {
            '@graph'?: { '@type': string; mainEntity?: Record<string, unknown> }[];
          },
      )
      .flatMap((value) => value?.['@graph'] ?? []);
    const mainEntity = graph.find((value) => value['@type'] === 'CollectionPage')?.mainEntity;
    expect(mainEntity).toBeDefined();
    let downloaded: Promise<unknown> | undefined;
    const captureDownload = (event: MouseEvent) => {
      const anchor = event.target;
      if (!(anchor instanceof HTMLAnchorElement) || !anchor.download.startsWith('collection-')) return;
      event.preventDefault();
      expect(anchor.href).toMatch(/^blob:/);
      expect(anchor.download).toMatch(/^collection-[a-zA-Z0-9_-]{1,80}\.jsonld$/);
      downloaded = fetch(anchor.href).then(async (response) => {
        expect(response.headers.get('content-type')).toBe('application/ld+json');
        return response.json();
      });
    };
    document.addEventListener('click', captureDownload, true);
    try {
      await userEvent.click(canvas.getByRole('button', { name: m.library_collection_export_download() }));
      expect(downloaded).toBeDefined();
      const exported = await downloaded;
      expect(exported).toEqual({ '@context': 'https://schema.org', ...mainEntity });
      expect(JSON.stringify(exported)).not.toMatch(
        /@graph|curator|revision|note|description|visibility|source|transaction/,
      );
      await expect(canvas.getByText(m.library_collection_export_downloaded())).toBeVisible();
    } finally {
      document.removeEventListener('click', captureDownload, true);
    }
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let copied = '';
    let denied = true;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (denied) throw new globalThis.Error('Clipboard denied');
          copied = text;
        },
      },
    });
    try {
      await userEvent.click(canvas.getByRole('button', { name: m.library_collection_export_copy() }));
      await expect(canvas.getByText(m.library_collection_export_failed())).toBeVisible();
      denied = false;
      await userEvent.click(canvas.getByRole('button', { name: m.library_collection_export_copy() }));
      await waitFor(() => expect(JSON.parse(copied)).toEqual({ '@context': 'https://schema.org', ...mainEntity }));
      await expect(canvas.getByText(m.library_collection_export_copied())).toBeVisible();
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  },
};

async function exportUnavailable(context: { canvasElement: HTMLElement }, title: string) {
  await variantReady(context, title);
  const canvas = within(context.canvasElement);
  await expect(canvas.queryByRole('group', { name: m.library_collection_export_label() })).toBeNull();
  await expect(canvas.queryByRole('button', { name: m.library_collection_export_download() })).toBeNull();
  await expect(canvas.queryByRole('button', { name: m.library_collection_export_copy() })).toBeNull();
  await expect(canvas.queryByText(m.library_collection_export_unavailable())).toBeNull();
}

export const PublicItemListExportOwnerUnavailable: Story = {
  name: 'Public ItemList export — owner view unavailable',
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.CuratorPrivateEmpty.id}`} />,
  play: (context) => exportUnavailable(context, variants.CuratorPrivateEmpty.title),
};

export const PublicItemListExportIncomplete: Story = {
  name: 'Public ItemList export — incomplete public view',
  render: () => <PageStory visitor="Signed Out" path={`/collections/${variants.ReaderPublicMany.id}`} />,
  play: (context) => exportUnavailable(context, variants.ReaderPublicMany.title),
};

export const CuratorPublicMany: Story = {
  ...variantStory(variants.CuratorPublicMany),
  play: async (context) => {
    await variantReady(context, variants.CuratorPublicMany.title);
    await expect(
      await within(context.canvasElement).findByText(m.library_member_count({ count: 4 }), { exact: true }),
    ).toBeVisible();
    await bookRowFactsReady(context);
  },
};
export const GridLayout: Story = {
  name: 'Grid Layout',
  play: async (context) => {
    await collectionReadyWithHover(context);
    await bookRowFactsReady(context);
    await expect(context.canvasElement.querySelector('[data-slot="cover-grid"]')).toBeVisible();
    await expect(context.canvasElement.querySelectorAll('[data-slot="cover-card"]')).toHaveLength(4);
  },
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-collection']}?layout=grid`} />,
};
export const ReaderPublicMany: Story = {
  ...variantStory(variants.ReaderPublicMany),
  play: async (context) => {
    await variantReady(context, variants.ReaderPublicMany.title);
    await expect(
      within(context.canvasElement).queryByText(
        m.library_member_count({
          count: variants.ReaderPublicMany.memberCount,
        }),
      ),
    ).toBeNull();
  },
};
export const CuratorPrivateEmpty = variantStory(variants.CuratorPrivateEmpty);
export const ReaderPrivate = variantStory(variants.ReaderPrivate);
export const CuratorPublicOnePage = variantStory(variants.CuratorPublicOnePage);

export const OwnerMenu: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.CuratorPublicMany.id}`} />,
  play: async (context) => {
    await variantReady(context, variants.CuratorPublicMany.title);
    const canvas = within(context.canvasElement);
    await expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.reaction_like() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.library_subject_save() })).toBeNull();
    const menu = canvas.getByRole('button', { name: m.library_collection_actions() });
    await userEvent.click(menu);
    const actions = await menuForTrigger(menu);
    await expect(actions.getByText(m.library_collection_edit(), { exact: true })).toBeVisible();
    await expect(actions.queryByText(m.report_action(), { exact: true })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu).toHaveFocus());
  },
};

export const DestinationOverflow: Story = {
  name: 'Library destinations in Collection overflow',
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-collection']} />,
  play: async (context) => {
    await libraryCollectionReady(context);
    const canvas = within(context.canvasElement);
    const trigger = canvas.getByRole('button', { name: m.library_collection_actions() });
    await expect(canvas.queryByRole('button', { name: new RegExp(m.library_nav_selector()) })).toBeNull();
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const actions = await menuForTrigger(trigger);
    const view = context.canvasElement.ownerDocument.defaultView!;
    const sheet = view.matchMedia('(max-width: 767px)').matches || view.matchMedia('(pointer: coarse)').matches;
    const selector = actions.getByRole(sheet ? 'button' : 'menuitem', { name: m.library_nav_selector() });
    selector.focus();
    await userEvent.keyboard(sheet ? '{Enter}' : '{ArrowRight}');
    const document = within(context.canvasElement.ownerDocument.body);
    const destination = await document.findByRole(sheet ? 'link' : 'menuitem', {
      name: m.library_nav_all_collections(),
    });
    await expect(destination).toBeVisible();
    await expect(destination).toHaveAttribute('href', `/${getLocale()}/library/collections`);
    if (sheet) {
      await userEvent.click(document.getByRole('button', { name: `‹ ${m.library_collection_cancel()}` }));
      await expect(await document.findByRole('dialog', { name: m.library_collection_actions() })).toBeVisible();
    } else {
      await userEvent.keyboard('{ArrowLeft}');
      await waitFor(() => expect(selector).toHaveFocus());
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    const toolbar = within(context.canvasElement.querySelector<HTMLElement>('[data-slot="collection-toolbar"]')!);
    const grid = toolbar.getByRole('link', { name: m.library_layout_grid() });
    await expect(grid).toHaveAttribute('href', `/${getLocale()}${pagePaths['library-collection']}?layout=grid`);
  },
};

export const MixedTypes: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${collectionReadStoryIds.mixed}`} />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    await waitFor(() =>
      expect(context.canvasElement.querySelectorAll('[data-slot="member-list-row-title"]')).toHaveLength(4),
    );
    await expect(within(context.canvasElement).queryByText(/Type:/)).toBeNull();
    const rowMenu = within(context.canvasElement).getAllByRole('button', {
      name: new RegExp(`${m.library_collection_actions()}:`),
    })[0]!;
    await userEvent.click(rowMenu);
    const actions = await menuForTrigger(rowMenu);
    await expect(actions.getByText(m.library_collection_copy(), { exact: true })).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

export const MembersPreparing: Story = {
  name: 'Members preparing',
  render: () => <PageStory visitor="Signed In" path={`/collections/${collectionReadStoryIds.preparing}`} />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_preparing())).toBeVisible();
    await expect(canvas.queryByText(m.library_collection_empty())).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.library_collection_export_download() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.library_collection_export_copy() })).toBeNull();
  },
};

export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${collectionReadStoryIds.unavailable}`} />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.library_collection_empty())).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_reload() }));
    await expect(await canvas.findByText(m.library_dynamic_unavailable())).toBeVisible();
  },
};

export const Error: Story = {
  render: () => <PageStory visitor="Signed Out" path={`/collections/${collectionReadStoryIds.error}`} />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(m.error_message())).toBeVisible();
    await expect(within(context.canvasElement).queryByText(m.library_collection_empty())).toBeNull();
  },
};

export const AnotherReader: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.ReaderPublicMany.id}`} />,
  play: async (context) => {
    await variantReady(context, variants.ReaderPublicMany.title);
    await bookRowFactsReady(context);
    const canvas = within(context.canvasElement);
    const trigger = canvas.getByRole('button', { name: m.library_collection_actions() });
    await userEvent.click(trigger);
    const actions = await menuForTrigger(trigger);
    await expect(actions.queryByText(m.report_action(), { exact: true })).toBeNull();
    await expect(actions.queryByText(m.library_collection_edit(), { exact: true })).toBeNull();
    await userEvent.keyboard('{Escape}');
  },
};

export const AnotherReaderGrid: Story = {
  ...AnotherReader,
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.ReaderPublicMany.id}?layout=grid`} />,
  play: async (context) => {
    await AnotherReader.play?.(context);
    await expect(context.canvasElement.querySelectorAll('[data-slot="cover-card"]')).toHaveLength(4);
    // The same exact localized author/year assertions run for AnotherReader's list and this page's grid.
    await expect(context.canvasElement.querySelectorAll('[data-slot="member-list-row-facts"]')).toHaveLength(4);
  },
};

export const MixedTypesGrid: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${collectionReadStoryIds.mixed}?layout=grid`} />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    await expect(context.canvasElement.querySelectorAll('[data-slot="cover-card"]')).toHaveLength(4);
    await expect(context.canvasElement.querySelector('[data-slot="member-list-row-facts"]')).toBeNull();
    const canvas = within(context.canvasElement);
    for (const member of collectionStoryMembers) {
      const author = member.facts['schema:author']![0]!;
      if (author.kind === 'item')
        await expect(canvas.queryByText(pickText(author.labels, getLocale()).text, { exact: true })).toBeNull();
      const publication = member.facts['schema:datePublished']?.[0];
      if (publication?.kind === 'time')
        await expect(
          canvas.queryByText(new Intl.NumberFormat(getLocale(), { useGrouping: false }).format(publication.year), {
            exact: true,
          }),
        ).toBeNull();
    }
  },
};

// An illustrative projection of one recorded statement for the same recorded subject, never a replacement
// for the collection's recording. No recorded author label or Film facts are available to project here.
const illustratedBook = memberRecording.members.find((member) => member.subject.id === subjectRecording.subject.id)!;
const illustratedYear = Number(
  subjectRecording.subject.statements['schema:datePublished'][0]!.value.content.time.slice(1, 5),
);
const illustratedPresentation = parseListPresentation(
  definitionsRecording.release.types['schema:Book'].listPresentation,
)!;

export const SuppliedBookFactsIllustrative: Story = {
  name: 'Supplied Book facts — illustrative DTO',
  parameters: {
    docs: {
      description: {
        story:
          'Illustrates the existing row renderer in list and grid using the recorded publication statement in subject.json for the same member ID. The collection FULL recording has no facts. This is not a recorded FULL fact response or native coverage; author and Film facts remain absent.',
      },
    },
  },
  render: () => {
    const locale = getLocale();
    const member: CollectionMember = {
      ...illustratedBook,
      subject: {
        ...subjectOf(illustratedBook.subject)!,
        typeLabel: pickText(definitionsRecording.release.types['schema:Book'].labels, locale).text,
      },
      facts: { 'schema:datePublished': [{ kind: 'time', year: illustratedYear }] },
    };
    return (
      <PatternStory>
        <main className="mx-auto max-w-5xl space-y-6 p-4">
          <h1 className="text-xl font-semibold">Illustrative supplied Book facts</h1>
          {(['list', 'grid'] as const).map((layout) => (
            <CollectionReadMembers
              key={layout}
              members={[member]}
              layout={layout}
              listPresentations={{ 'schema:Book': illustratedPresentation }}
              onCopy={() => {}}
            />
          ))}
        </main>
      </PatternStory>
    );
  },
  play: async (context) => {
    const facts = context.canvasElement.querySelectorAll('[data-slot="member-list-row-facts"]');
    await expect(facts).toHaveLength(2);
    const year = new Intl.NumberFormat(getLocale(), { useGrouping: false }).format(illustratedYear);
    for (const fact of facts) await expect(fact).toHaveTextContent(year);
    await expect(
      within(context.canvasElement).getAllByRole('link', { name: illustratedBook.subject.label.value }),
    ).toHaveLength(2);
  },
};

function render(
  mode: Parameters<typeof setCollectionStoryMode>[0],
  visitor: 'Signed In' | 'Signed Out' = 'Signed In',
  path = pagePaths['library-collection'],
) {
  setCollectionStoryMode(mode);
  return <PageStory visitor={visitor} path={path} credentialMode={visitor === 'Signed In' ? 'session' : 'anonymous'} />;
}

async function detailReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: 'Books I come back to' });
  return view;
}

export const Curator: Story = {
  name: 'Owner, private collection',
  tags: ['!dev'],
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('button', { name: m.library_collection_actions() });
    await view.findByRole('heading', {
      level: 2,
      name: m.library_collection_members(),
    });
  },
};

export const PrivateCurator: Story = {
  name: 'Owner, private visibility',
  tags: ['!dev'],
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getByText(m.library_visibility_private(), { exact: true })).toBeVisible();
  },
};

export const PrivateNotFound: Story = {
  name: 'Signed out, private collection unavailable',
  tags: ['!dev'],
  render: () => render('hidden', 'Signed Out'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const UnknownNotFound: Story = {
  name: 'Signed out, unknown collection',
  tags: ['!dev'],
  render: () => render('hidden', 'Signed Out', '/collections/00000000-0000-4000-8000-000000000000'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const UnlistedVisitor: Story = {
  name: 'Signed out, unlisted collection',
  render: () => render('unlisted', 'Signed Out'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.queryByRole('button', { name: m.library_collection_actions() })).toBeNull();
    await expect(view.getByText(m.library_member_count({ count: 0 }))).toBeVisible();
    await expect(view.getByText(m.library_collection_empty())).toBeVisible();
    await expect(view.getByRole('button', { name: m.library_collection_add_items() })).toBeVisible();
    await expect(view.queryByRole('link', { name: 'The Little Prince' })).toBeNull();
    await expect(context.canvasElement.ownerDocument.querySelector('script[type="application/ld+json"]')).toBeNull();
  },
};

export const PublicVisitor: Story = {
  name: 'Signed out, public collection',
  tags: ['!dev'],
  parameters: {
    docs: {
      description: {
        story:
          'Constructed own-cover DTO using the existing imported-cover fixture through the default page caller; not a newly recorded Collection cover response or native evidence.',
      },
    },
  },
  render: () => render('presentation', 'Signed Out'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'The Tale of Genji' });
    const identity = context.canvasElement.querySelector('[data-collection-cover-source="owner"]');
    await expect(identity).toBeVisible();
    await expect(identity!.querySelector('[data-slot="cover"]')).toHaveAttribute('data-ratio', defaultCoverRatio);
    await expect(identity!.querySelector('img')).toHaveAttribute(
      'src',
      `/media/${subjectRecording.summary.cover.media}/webp-320`,
    );
  },
};

export const Empty: Story = {
  name: 'Owner, empty collection',
  tags: ['!dev'],
  render: () => render('empty'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getByText(m.library_collection_empty())).toBeVisible();
  },
};

export const OnePage: Story = {
  name: 'Owner, one page of members',
  tags: ['!dev'],
  render: () => render('one-page'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Snow Country' });
    await expect(view.queryByRole('link', { name: m.library_collection_more() })).toBeNull();
  },
};

export const ManyPages: Story = {
  name: 'Owner, multiple pages of members',
  tags: ['!dev'],
  render: () => render('many-pages'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: m.library_collection_more() });
  },
};

export const NotesAndDuplicates: Story = {
  name: 'Owner, duplicate members with notes',
  tags: ['!dev'],
  render: () => render('notes-duplicates'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByText('A second occurrence with its own note.');
    await view.findByText(m.library_member_count({ count: 5 }), {
      exact: true,
    });
    await expect(view.getAllByRole('link', { name: 'Snow Country' })).toHaveLength(2);
  },
};

export const LongNotesSparseContinuation: Story = {
  name: 'Owner, long notes with sparse continuation',
  parameters: {
    docs: {
      description: {
        story:
          'Actual browse route. Duplicate occurrences keep distinct IDs for one mixed-script identity, document-derived notes, and a withheld member without invented facts. Continuation stays offered for empty slices. Overflow, keyboard and target-size are unmeasured until admitted capture; canonical ID comes from the admitted index.',
      },
    },
  },
  render: () => render('long-notes-sparse'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getAllByRole('link', { name: collectionLongNotesSparse.identity })).toHaveLength(2);
    for (const note of collectionLongNotesSparse.notes) await view.findByText(note);
    await view.findByRole('link', { name: m.library_collection_more() });
    await expect(view.getByText(m.library_subject_unavailable())).toBeVisible();
    await expect(view.queryByRole('link', { name: (accessibleName) => accessibleName === 'Snow Country' })).toBeNull();
  },
};

export const DeepPage: Story = {
  name: 'Owner, deeper members',
  tags: ['!dev'],
  render: () => render('deep-page', 'Signed In', `${pagePaths['library-collection']}?cursor=page-two`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'The Little Prince' });
  },
};

export const FinalPage: Story = {
  name: 'Owner, last members',
  tags: ['!dev'],
  render: () => render('final-page', 'Signed In', `${pagePaths['library-collection']}?cursor=page-three`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Kokoro' });
    await expect(view.queryByRole('link', { name: m.library_collection_more() })).toBeNull();
  },
};

export const Preparing: Story = {
  name: 'Owner, page unavailable',
  tags: ['!dev'],
  render: () => render('preparing'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const RestartAfterEpochChange: Story = {
  name: 'Owner, refreshed member list',
  tags: ['!dev'],
  render: () => render('stale', 'Signed In', `${pagePaths['library-collection']}?cursor=old-epoch`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Snow Country' });
  },
};
