import recording from '../../../kernel/recorded/agent-page.json';
import readerRecording from '../../../kernel/recorded/agent-page-reader.json';
import threadPosts from '../../../kernel/recorded/thread-posts.json';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectPageData } from '../../../features/pages/subject';
import { isRecord } from '../../../features/pages/shared';

/** Public recordings with small wire-state variations; no private verification request is used. */
export function profilePage(
  options: {
    verified?: boolean;
    profile?: Record<string, unknown>;
    activityStatus?: number;
    empty?: boolean;
  } = {},
): SubjectPageData {
  const source = structuredClone(options.verified ? recording : readerRecording);
  const page = { ...source, account: { id: source.account, handle: source.handle } } as unknown as SubjectPageData;
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    if (Array.isArray(result.body.accounts)) {
      result.body.accounts = result.body.accounts.map((profile) =>
        isRecord(profile)
          ? {
              ...profile,
              publicViews: { posts: true, reviews: true, collections: true, realms: true },
              ...options.profile,
            }
          : profile,
      );
    }
    for (const field of ['posts', 'threads', 'collections'])
      if (Array.isArray(result.body[field])) {
        if (options.activityStatus) {
          result.status = options.activityStatus;
          result.body = {};
          break;
        }
        if (options.empty) {
          result.body[field] = [];
          result.body.next = null;
        }
      }
  }
  return page;
}

export type ContributionView = 'posts' | 'reviews' | 'collections';

/** Illustrative dedicated composition over the same admitted recording, with no extra product reads. */
export function contributionPage(view?: ContributionView): SubjectPageData {
  const page = profilePage();
  if (!view) return page;
  const sourcePlan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    account: page.account!,
  });
  const type = view === 'posts' ? 'AccountPosts' : view === 'reviews' ? 'AccountThreads' : 'AccountCollections';
  const node = page.document.content.find((node) => node.type === type)!;
  page.document = {
    root: page.document.root,
    content: [
      { type: 'AccountIdentity', props: { id: 'account-identity' } },
      { ...node, props: { ...node.props, paged: true, limit: view === 'collections' ? 24 : 20 } },
    ],
  };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    account: page.account!,
  });
  page.reads = Object.fromEntries(
    Object.entries(plan.reads).map(([key, read]) => {
      const source = Object.entries(sourcePlan.reads).find(([, original]) => original.kind === read.kind)!;
      return [key, page.reads[source[0]]!];
    }),
  );
  return page;
}

export const contributionLongTitle = '閱讀與翻譯 — Reading across languages 日本語 한국어 '.repeat(8).trim();

/** Keep the original native paragraphs and marks; repeat bounded supplied prose to exercise clipping. */
export function clippedContributionPage(): SubjectPageData {
  const page = contributionPage();
  const passive = readerRecording.reads.r11.body.posts[0]!.body.doc.content[0]!;
  const linked = threadPosts.posts[1]!.body.doc.content[0]!;
  const spoiler = threadPosts.posts[2]!.body;
  const rich = {
    ...structuredClone(threadPosts.posts[1]!.body),
    doc: {
      type: 'doc',
      content: [
        passive,
        linked,
        ...Array.from({ length: 10 }, (_, index) => ({
          ...structuredClone(passive),
          attrs: { ...passive.attrs, id: `clipped-paragraph-${index}` },
        })),
      ],
    },
  };
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    const { posts, threads } = result.body;
    if (Array.isArray(posts)) {
      if (isRecord(posts[0]) && isRecord(posts[0].thread)) {
        posts[0].thread.title = contributionLongTitle;
        posts[0].body = structuredClone(rich);
      }
      if (isRecord(posts[1])) posts[1].body = structuredClone(spoiler);
    }
    if (Array.isArray(threads)) {
      if (isRecord(threads[0]) && isRecord(threads[0].firstPost)) {
        threads[0].title = contributionLongTitle;
        threads[0].firstPost.body = structuredClone(rich);
      }
      if (isRecord(threads[1]) && isRecord(threads[1].firstPost)) threads[1].firstPost.body = structuredClone(spoiler);
    }
  }
  return page;
}
