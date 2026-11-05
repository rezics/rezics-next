import { fromMarkdown, type DocumentNode } from '@rezics/document';
import type { ThreadPost } from '../threads/reads';
import type { PageAuthor } from '../identity/read';
import type { ThreadReadingPage } from '../threads/thread-reading';
import type { DocumentImagePresentation } from '../threads/document-media';
import type { ExactRevisionState } from '../threads/exact-revision';
import recordedThread from '../kernel/recorded/thread.json';
import recordedPosts from '../kernel/recorded/thread-posts.json';
import recordedAccounts from '../kernel/recorded/accounts.json';
import recordedSubject from '../kernel/recorded/subject.json';

export const readingEnding = '最後まで読める文書。 The full ending remains available. é 👩🏽‍🚀';
export const readingSecret = 'The travellers return to the same observatory. 旅人は同じ天文台に戻る。';
export const readingAlt = 'Prepared illustration accompanying the multilingual field notes';
export const readingLongLink = `https://example.test/notes/${'unbroken-path-'.repeat(22)}`;

/** Prepared examples on recorded DTOs; they establish no native source or disclosure authority. */
export function preparedPostReading(blocks = 24) {
  const cover = recordedSubject.summary.cover;
  const image: DocumentImagePresentation = {
    id: cover.media,
    containerId: recordedThread.thread.id,
    digest: '0'.repeat(64),
    width: cover.width,
    height: cover.height,
    variants: cover.variants.flatMap(({ format, width }) =>
      format === 'webp' || format === 'avif' ? [{ format, width, height: cover.height }] : [],
    ),
    placeholder: cover.placeholder,
    focalPoint: null,
    credit: { ...cover.credit, obligations: [] },
  };
  const body = fromMarkdown(
    [
      '# Field notes / 観測記録',
      'A short introduction keeps the author and the document distinct.',
      ...Array.from(
        { length: blocks },
        (_, index) =>
          `Reading ${index + 1}. ${'星を読む。文書の言語を保つ。 Latin words, é and 👩🏽‍🚀 stay intact. '.repeat(3)}`,
      ),
      '> A quoted observation stays beside its source. 引用の境界も保持する。',
      '- A complete list item\n- Another complete item',
      '1. Read the document\n2. Inspect the selected revision\n3. Return to this post',
      `\`\`\`typescript\nconst destination = '${'a-long-unbroken-value'.repeat(12)}';\n  console.log(destination);\n\`\`\``,
      '| Observation / 観測 | Notes / 記録 |\n| --- | --- |\n| North | A complete table cell |\n| South | 文書の最後まで読む |',
      `[${readingLongLink}](${readingLongLink})`,
      `Before the spoiler. >!${readingSecret}!< After the spoiler.`,
      readingEnding,
    ].join('\n\n'),
    'blocks',
  );
  for (const [index, node] of body.doc.content!.entries()) {
    if (node.type === 'paragraph' && index >= 2 && index < blocks + 2)
      node.attrs = { ...node.attrs, lang: index % 2 ? 'ja' : 'en' };
  }
  body.doc.content!.splice(3, 0, { type: 'image', attrs: { src: image.id, alt: readingAlt } } satisfies DocumentNode);
  const opening = recordedPosts.posts[0] as Extract<ThreadPost, { availability: 'available' }>;
  const post = { ...opening, body, mediaIds: [image.id] };
  const authors = Object.fromEntries(
    (recordedAccounts.accounts as PageAuthor[]).map((author) => [
      author.id,
      {
        ...author,
        displayName: `${'displayName' in author ? author.displayName : ''} / ${'星の観測と多言語の記録 '.repeat(5)}`,
      },
    ]),
  );
  const documentMedia = {
    kind: 'ready' as const,
    images: [image],
    documents: [
      {
        postId: post.id,
        threadId: post.threadId,
        revisionId: post.revisionId,
        sha256: post.sha256,
        mediaIds: post.mediaIds,
      },
    ],
  };
  const page: ThreadReadingPage = {
    thread: { ...(recordedThread.thread as ThreadReadingPage['thread']), firstPost: post },
    posts: { posts: [post], next: null, reactionsAsOf: null },
    authors,
    mentions: {},
    subjects: [],
    provenanceSubjects: [],
    documentMedia,
    verification: { sitekey: '', scriptUrl: '' },
    now: '2026-10-27T12:00:00.000Z',
  };
  const revision: ExactRevisionState = {
    state: 'ready',
    revision: post,
    thread: { id: post.threadId, title: page.thread.title, differentHead: false },
    authors,
    mentions: {},
    documentMedia: { kind: 'ready', images: new Map([[image.id, image]]) },
    now: page.now,
  };
  return { page, post, image, revision };
}
