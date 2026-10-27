import { documentText, type DocumentSnapshot } from '@rezics/document';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthor, PageAuthors } from '../identity/read';
import { pageHead, type HeadContext } from '../shell/head';
import { validatePublicOrigin } from '../shell/origin';
import type { BoardRealm } from './board-context';
import { subjectTitle, type ThreadSubject } from './subjects';
import { threadHref, threadTitle } from './thread-href';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

type PostLike = {
  id: string;
  authorId?: string;
  createdAt?: string;
  body?: unknown;
  availability?: string;
};

export type ThreadHeadPage = {
  indexable: boolean;
  thread: {
    id: string;
    title?: string | null;
    createdAt: string;
    authorId: string;
    subjectIds: readonly string[];
    firstPost: { id: string; body?: unknown };
    replyCount?: number;
  };
  board?: { id: string; title?: string | null };
  realm?: BoardRealm;
  posts: { posts: PostLike[] };
  authors: PageAuthors;
  subjects: ThreadSubject[];
};

export type BoardHeadPage = {
  indexable: boolean;
  board: { id: string; title?: string | null };
  realm?: BoardRealm;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function walkText(node: unknown): string {
  if (!isRecord(node)) return '';
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  const joiner = node.type === 'doc' || node.type === 'paragraph' ? '' : '\n';
  if (node.type === 'paragraph' || node.type === 'heading') return node.content.map(walkText).join('');
  return node.content
    .map(walkText)
    .filter(Boolean)
    .join(node.type === 'doc' ? '\n' : joiner);
}

/** Plain text of a post document. Invalid documents still yield their visible text. */
function postText(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.doc)) return '';
  try {
    return documentText(body as unknown as DocumentSnapshot);
  } catch {
    return walkText(body.doc);
  }
}

function person(author: PageAuthor | undefined, origin: string, locale: string) {
  return {
    '@type': 'Person',
    name: author?.displayName || author?.handle || m.thread_author_unknown(),
    ...(author?.handle ? { url: `${origin}/${locale}/@${encodeURIComponent(author.handle)}` } : {}),
  };
}

function replyCount(thread: { replyCount?: number }): number {
  return typeof thread.replyCount === 'number' && Number.isFinite(thread.replyCount) ? thread.replyCount : 0;
}

/** The first attached subject's closest published cover variant to the default card width. */
function cardImage(subjects: ThreadSubject[], firstSubjectId: string | undefined, alt: string) {
  if (!firstSubjectId) return undefined;
  const subject = subjects.find((item) => item.id === firstSubjectId);
  const cover = subject?.cover;
  if (!subject || !cover || cover.withheld || cover.variants.length === 0 || cover.width <= 0) return undefined;

  const width = [...new Set(cover.variants.map((variant) => variant.width))].sort(
    (a, b) => Math.abs(a - 1200) - Math.abs(b - 1200) || b - a,
  )[0];
  if (width === undefined) return undefined;
  const variant =
    cover.variants.find((item) => item.width === width && item.format === 'webp') ??
    cover.variants.find((item) => item.width === width);
  if (!variant) return undefined;

  return {
    url: coverSrc(cover.media, variant.format, width),
    width,
    height: Math.max(1, Math.round((cover.height * width) / cover.width)),
    alt: subjectTitle(subject, getLocale()) || alt,
  };
}

function contextFor(path: string): HeadContext | undefined {
  try {
    return { origin: publicOrigin(), locale: getLocale(), path };
  } catch {
    return undefined;
  }
}

function breadcrumb(items: { name: string; path: string }[], origin: string, locale: string) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${origin}/${locale}${item.path}`,
    })),
  };
}

export function threadPageHead(page: ThreadHeadPage) {
  const locale = getLocale();
  const title = threadTitle(page.thread) ?? m.threads_untitled();
  const path = threadHref({ id: page.thread.id, title: threadTitle(page.thread) });
  const context = contextFor(path);
  if (!context) return { meta: [{ title }] };
  const opening = postText(page.thread.firstPost.body);
  const author = page.authors?.[page.thread.authorId];
  const comments = page.posts.posts.flatMap((post) => {
    if (post.id === page.thread.firstPost.id || !post.createdAt) return [];
    const text = post.availability === 'erased' ? '' : postText(post.body);
    if (!text) return [];
    const commentAuthor = post.authorId ? page.authors?.[post.authorId] : undefined;
    return [
      {
        '@type': 'Comment',
        text,
        datePublished: post.createdAt,
        author: person(commentAuthor, context.origin, locale),
      },
    ];
  });
  const crumbs = [
    ...(page.realm ? [{ name: page.realm.title, path: `/realms/${encodeURIComponent(page.realm.id)}` }] : []),
    ...(page.board
      ? [{ name: page.board.title || m.threads_untitled(), path: `/boards/${encodeURIComponent(page.board.id)}` }]
      : []),
    { name: title, path },
  ];
  const image = cardImage(page.subjects, page.thread.subjectIds[0], title);
  return pageHead(
    {
      title,
      ...(opening ? { description: opening } : {}),
      type: 'article',
      ...(image ? { image } : {}),
      ...(page.indexable ? {} : { robots: 'noindex, follow' }),
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'DiscussionForumPosting',
            headline: title,
            ...(opening ? { text: opening } : {}),
            author: person(author, context.origin, locale),
            datePublished: page.thread.createdAt,
            url: `${context.origin}/${locale}${path}`,
            ...(comments.length ? { comment: comments } : {}),
            interactionStatistic: {
              '@type': 'InteractionCounter',
              interactionType: 'https://schema.org/CommentAction',
              userInteractionCount: replyCount(page.thread),
            },
          },
          breadcrumb(crumbs, context.origin, locale),
        ],
      },
    },
    context,
  );
}

export function boardPageHead(page: BoardHeadPage) {
  const locale = getLocale();
  const title = page.board.title || m.threads_untitled();
  const path = `/boards/${encodeURIComponent(page.board.id)}`;
  const context = contextFor(path);
  const description = page.realm
    ? m.board_meta_description_realm({ title, realm: page.realm.title })
    : m.board_meta_description({ title });
  if (!context) return { meta: [{ title }] };
  const crumbs = [
    ...(page.realm ? [{ name: page.realm.title, path: `/realms/${encodeURIComponent(page.realm.id)}` }] : []),
    { name: title, path },
  ];
  return pageHead(
    {
      title,
      description,
      ...(page.indexable ? {} : { robots: 'noindex, follow' }),
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'CollectionPage',
            name: title,
            description,
            url: `${context.origin}/${locale}${path}`,
          },
          breadcrumb(crumbs, context.origin, locale),
        ],
      },
    },
    context,
  );
}
