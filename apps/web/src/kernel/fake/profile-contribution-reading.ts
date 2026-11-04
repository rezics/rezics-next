/** Prepared owner-shaped examples, not evidence of native context admission or producer delivery. */
export function preparedProfileContributions() {
  const account = '01a1a000-0000-7000-8000-000000000001';
  const thread = '01a1a000-0000-7000-8000-000000000002';
  const post = '01a1a000-0000-7000-8000-000000000003';
  const revision = '01a1a000-0000-7000-8000-000000000004';
  const body = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A careful reading in its original conversation.' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Prepared hidden ending', marks: [{ type: 'spoiler' }] }],
        },
      ],
    },
  };
  const base = {
    availability: 'available',
    visibility: 'published',
    authorId: account,
    createdAt: '2026-11-01T09:00:00Z',
  };
  const reply = {
    ...base,
    id: post,
    revisionId: revision,
    threadId: thread,
    parentId: 'prepared-parent',
    thread: { id: thread, title: 'Two readings of the same scene' },
    body,
    parentContext: {
      kind: 'reply',
      parent: {
        state: 'available',
        id: 'prepared-parent',
        revisionId: 'prepared-parent-revision',
        excerpt: 'Prepared concealed parent ending',
        spoiler: true,
        language: 'en',
        author: { id: account, displayName: 'Prepared reader', handle: 'prepared_reader' },
      },
    },
  };
  const review = {
    ...base,
    id: thread,
    kind: 'review',
    title: 'What the ending changes',
    firstPost: { ...base, id: post, revisionId: revision, body },
    reviewContext: {
      target: {
        state: 'available',
        subject: { id: 'prepared-work', label: { value: 'Prepared reviewed work', language: 'en' } },
      },
      citation: {
        state: 'available',
        question: { id: 'prepared-question', revision: 3, label: 'How does the ending hold up?' },
        voteRevision: 7,
        units: 80,
      },
    },
    conversationActivity: {
      state: 'current',
      cohort: 'public',
      count: { kind: 'lower-bound', value: 12 },
      lastActivityAt: '2026-11-02T10:00:00Z',
    },
  };
  return { account, reply, review };
}
