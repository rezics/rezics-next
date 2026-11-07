import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import { DocumentBody } from '@rezics/ui/document-body';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import { loadThreadPage, type ReadingPage } from '../src/threads/thread-page';
import {
  mentionsForThreadPost,
  publishedCitationForPost,
  readingPageReviewContext,
} from '../src/threads/thread-page-context';
import { RevisionProvenance } from '../src/threads/revision-provenance-view';
import { m } from '../src/paraglide/messages.js';

const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000006';
const questionId = '0192f3a0-6c1e-7b2a-9d4e-000000000007';
const opening: Extract<ReadingPage['thread']['firstPost'], { availability: 'available' }> = {
  id: postId,
  threadId,
  revisionId,
  route: 0,
  authorId: accountId,
  parentId: null,
  boardId: threadId,
  subjectIds: [subjectId],
  visibility: 'published',
  securityRevision: '1',
  availability: 'available',
  createdAt: '2026-11-04T00:00:00.000Z',
  revisedAt: null,
  licence: 'CC0-1.0',
  sha256: 'a'.repeat(64),
  mediaIds: [mediaId],
  voteCitation: { questionId, units: 0, revision: 3 },
  body: fromPlainText('A review', 'blocks'),
};

function page() {
  return authoredReadingPage({
    id: threadId,
    route: 0,
    authorId: accountId,
    boardId: threadId,
    kind: 'review',
    title: 'A review',
    subjectIds: [subjectId],
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt: opening.createdAt,
    licence: opening.licence,
    firstPost: opening,
  });
}

test('the mounted review reaches the reader with its recorded zero, vote revision and independently supplied Subject', async () => {
  const response = page();
  delete response.mentions;
  response.reviewContext = {
    source: { threadId, postId, revisionId },
    target: {
      state: 'available',
      subject: { id: subjectId, kind: 'work', label: { value: 'Reviewed work', language: 'en' } },
    },
    citations: {
      state: 'current',
      items: [
        {
          postId,
          sourceRevisionId: revisionId,
          citation: {
            state: 'available',
            questionId,
            units: 0,
            voteRevision: 3,
            metadata: { state: 'unavailable' },
          },
        },
      ],
    },
  };
  const context = readingPageReviewContext(response)!;
  const citation = publishedCitationForPost(context, opening)!;
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      if (path === `/v1/threads/${threadId}/reading-page`) return Response.json(response);
      if (path === `/v1/boards/${threadId}`) return Response.json({});
      throw new Error(`Unexpected enrichment read: ${path}`);
    },
  });
  const loaded = await loadThreadPage(
    client,
    new Request('https://web.test/'),
    {},
    { id: threadId },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  expect(loaded.composed?.reviewContext).toEqual(context);
  expect(loaded.documentMentions).toEqual({ state: 'unavailable', sources: [], identities: [] });
  expect(paths).toEqual([`/v1/threads/${threadId}/reading-page`, `/v1/boards/${threadId}`]);
  const markup = renderToStaticMarkup(
    <RevisionProvenance
      revision={opening}
      subjects={[]}
      publishedCitation={citation}
      reviewTarget={context.target}
      review
      currentVote={{ questionId, units: 9, revision: 4 }}
    />,
  );
  expect(markup).toContain('Reviewed work');
  expect(markup).toContain(m.discussion_provenance_details_rating_units({ units: '0' }));
  expect(markup).toContain(m.thread_provenance_vote({ units: '0', questionId, revision: '3' }));
  expect(markup).toContain(m.search_review_historical_question_unavailable());
  expect(publishedCitationForPost(context, { ...opening, revisionId: subjectId })).toBeUndefined();
  response.reviewContext.source.revisionId = subjectId;
  expect(readingPageReviewContext(response)).toBeUndefined();
  const concealed = renderToStaticMarkup(
    <RevisionProvenance revision={opening} subjects={[]} publishedCitation={{ state: 'withheld' }} review />,
  );
  expect(concealed).toContain(m.subject_community_citation_unavailable());
  expect(concealed).not.toContain(questionId);
  expect(concealed).not.toContain(m.thread_provenance_unscored());
});

test('post mentions retain the first disclosed identity and only render references in the exact body occurrence', () => {
  const post = {
    ...opening,
    body: {
      ...opening.body,
      doc: {
        ...opening.body.doc,
        content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { accountId } }] }],
      },
    },
  };
  const projection = {
    state: 'current',
    sources: [
      {
        postId,
        threadId,
        revisionId,
        sha256: post.sha256,
        pageIndex: 1,
        references: [accountId, subjectId],
        overflow: false,
      },
    ],
    identities: [
      { id: accountId, state: 'concealed' },
      { id: accountId, state: 'active', handle: 'later-active' },
      { id: subjectId, state: 'active', handle: 'not-in-body' },
    ],
  } as const;
  const mentions = mentionsForThreadPost(projection, post, 1);
  expect(mentions).toEqual({});
  const html = renderToStaticMarkup(<DocumentBody document={post.body} mentions={mentions} />);
  expect(html).not.toContain('later-active');
  expect(html).not.toContain('not-in-body');
  const disclosed = {
    ...projection,
    identities: [{ id: accountId, state: 'active', handle: 'first-active' }, ...projection.identities],
  } as const;
  expect(mentionsForThreadPost(disclosed, post, 1)).toEqual({ [accountId]: { handle: 'first-active' } });
  expect(mentionsForThreadPost(disclosed, post, 0)).toEqual({});
  expect(mentionsForThreadPost(disclosed, { ...post, revisionId: subjectId }, 1)).toEqual({});
});
