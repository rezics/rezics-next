import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { readSubjectCommunity, type CommunityKind, type SubjectCommunity } from '../features/pages/subject-community';
import type { CommunityCard } from '../features/pages/subject-community-card';
import {
  SubjectCommunityContext,
  SubjectCommunityRegion,
  SubjectCommunityVerificationContext,
} from '../features/pages/subject-community-view';
import { GLOBAL } from '../features/pages/subject-ratings';
import type { ThreadReactionsProps } from '../threads/thread-reactions';
import type { ThreadWatchNative } from '../threads/thread-watch-native';
import {
  communityAuthor,
  communitySubject,
  communityThread,
  communityThreadPage,
} from '../kernel/fake/subject-community';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { getLocale } from '../paraglide/runtime.js';
import { subjectViewHref } from '../subject/subject-href';
import { PatternStory } from './page';

type Scenario =
  | 'anonymous'
  | 'member'
  | 'writer'
  | 'actions'
  | 'zero'
  | 'changed-scale'
  | 'retired-target'
  | 'concealed';

const unavailableReactions: NonNullable<ThreadReactionsProps['preparedTransport']> = {
  async change() {
    return { ok: false, reason: 'unavailable' };
  },
  async read() {
    return { ok: false, reason: 'unavailable' };
  },
};
const uncertainWatch: ThreadWatchNative = {
  async read() {
    return { kind: 'unavailable' };
  },
  async set() {
    return { kind: 'unknown' };
  },
};
function CurrentCommunityReading({
  scenario = 'anonymous',
  kind = 'review',
}: {
  scenario?: Scenario;
  kind?: CommunityKind;
}) {
  const locale = getLocale();
  const [data, setData] = useState<SubjectCommunity>();
  const [client] = useState(() => new QueryClient());
  const reader = scenario === 'anonymous' ? null : scenario === 'writer' ? communityAuthor.id : 'story-reader';
  const place = scenario === 'member' ? '01a1a000-0000-7000-8000-000000000096' : GLOBAL;
  useEffect(() => {
    let current = true;
    client.setQueryData(
      ['session'],
      reader ? { state: 'signed-in', subject: reader, csrfToken: 'story-csrf' } : { state: 'signed-out' },
    );
    setData(undefined);
    const fallback = createStoryRecordedKernelFetch();
    const kernel = createKernelClient('https://kernel.invalid', {
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (!url.pathname.endsWith('/threads')) return fallback(input, init);
          if (scenario === 'concealed') return Response.json({ code: 'not_found' }, { status: 404 });
          const thread = communityThread(kind);
          const post = thread.firstPost;
          if (post.availability !== 'available') throw new Error('Expected an available opening');
          const recorded = {
            questionId: '01a1a000-0000-7000-8000-000000000085',
            units: scenario === 'zero' ? 0 : 14,
            revision: 2,
          };
          const opening = { ...post, voteCitation: kind === 'review' ? recorded : null };
          const card: CommunityCard = {
            version: 1,
            threadId: thread.id,
            postRevisionId: post.revisionId,
            citation:
              kind === 'discussion'
                ? { state: 'absent' }
                : {
                    state: 'available',
                    postRevisionId: post.revisionId,
                    recorded,
                    question: {
                      id: recorded.questionId,
                      revision: 3,
                      label: 'Rating when written',
                      scale: { min: 0, max: 20, displayStep: 2 },
                      lifecycle: { state: scenario === 'retired-target' ? 'retired' : 'active', revision: 4 },
                    },
                    originalTarget:
                      scenario === 'retired-target'
                        ? {
                            id: '01a1a000-0000-7000-8000-000000000099',
                            label: 'Original edition',
                            mergedInto: communitySubject.id,
                          }
                        : { ...communitySubject, mergedInto: null },
                  },
            activity: { replyCount: 0, lastActivityAt: '2026-11-01T12:00:00Z' },
            media: [],
          };
          // This consumer seam is deliberately independent of the installed current-question reviewContext.
          const actionCard = {
            state: 'current',
            authors: {
              thread: {
                state: 'current',
                identity: { displayName: communityAuthor.displayName, handle: communityAuthor.handle, avatar: null },
              },
              openingPost: {
                state: 'current',
                identity: { displayName: communityAuthor.displayName, handle: communityAuthor.handle, avatar: null },
              },
            },
            presentation: { state: 'current', language: 'en', spoiler: false },
            media: { state: 'none', images: [] },
            comments: {
              state: 'current',
              cohort: 'public',
              count: { kind: 'exact', value: 0 },
              lastActivityAt: null,
              source: { epoch: 1, position: '1' },
            },
            actions: {
              state: 'current',
              retryable: false,
              references: [
                {
                  type: 'content.thread',
                  id: thread.id,
                  sourceRevisionId: post.revisionId,
                  state: 'current',
                  operations: [
                    { action: 'post:create', operationId: 'post.create', state: 'available' },
                    { action: 'reaction:set', operationId: 'thread.set_reaction', state: 'available' },
                    { action: 'reaction:set', operationId: 'thread.clear_reaction', state: 'available' },
                    { action: 'thread:watch', operationId: 'thread.watch', state: 'available' },
                    { action: 'thread:watch', operationId: 'thread.unwatch', state: 'not_applicable' },
                    { action: 'report:create', operationId: 'report.create', state: 'available' },
                  ],
                },
              ],
            },
            reply: { state: 'available' },
            watch: { state: 'current', watching: false },
            currentness: {
              source: 'current',
              place: 'current',
              authors: 'current',
              reactions: 'current',
              actions: 'current',
              watch: 'current',
              media: 'current',
              comments: 'current',
            },
          };
          const native = {
            ...thread,
            firstPost: opening,
            ...(['actions', 'anonymous', 'member', 'writer'].includes(scenario)
              ? {
                  card:
                    scenario === 'actions'
                      ? actionCard
                      : {
                          ...actionCard,
                          actions: { state: 'unavailable', retryable: true, references: [] },
                          reply: { state: 'unavailable' },
                          watch: { state: 'unavailable', retryable: true },
                          currentness: { ...actionCard.currentness, actions: 'unavailable', watch: 'unavailable' },
                        },
                }
              : { card }),
            ...(scenario === 'changed-scale'
              ? {
                  reviewContext: {
                    citation: { state: 'available', units: 5, question: { scale: { min: 1, max: 5 } } },
                  },
                }
              : {}),
          };
          return Response.json(communityThreadPage(kind, communitySubject, [native], null, place));
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    });
    void readSubjectCommunity(kernel, communitySubject.id, [kind], true, undefined, reader, place).then((result) => {
      if (current) setData(result);
    });
    return () => {
      current = false;
    };
  }, [scenario, kind, locale, reader, place, client]);
  return (
    <QueryClientProvider client={client}>
      <SubjectCommunityContext.Provider value={data}>
        <SubjectCommunityVerificationContext.Provider
          value={{ sitekey: '', scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' }}
        >
          <PatternStory>
            <div className="mx-auto w-full max-w-4xl p-4 sm:p-8">
              <SubjectCommunityRegion
                id="community-current"
                kind={kind}
                region={data?.regions[kind] ?? { state: 'loading' }}
                authors={data?.authors ?? {}}
                now="2026-11-02T00:00:00Z"
                subject={communitySubject}
                locale={locale}
                href={subjectViewHref(communitySubject, locale, kind === 'review' ? 'reviews' : 'discussion')}
                paged
                {...(scenario === 'actions'
                  ? { preparedTransport: unavailableReactions, preparedWatch: uncertainWatch }
                  : {})}
              />
            </div>
          </PatternStory>
        </SubjectCommunityVerificationContext.Provider>
      </SubjectCommunityContext.Provider>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Subjects/Current Reading',
  id: 'patterns-subject-community-current-reading',
  component: CurrentCommunityReading,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CurrentCommunityReading>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Anonymous: Story = { args: { scenario: 'anonymous' } };
export const Member: Story = { args: { scenario: 'member', kind: 'discussion' } };
export const Writer: Story = { args: { scenario: 'writer' } };
export const AdmittedActions: Story = { args: { scenario: 'actions', kind: 'discussion' } };
export const Zero: Story = { args: { scenario: 'zero' } };
export const ChangedScale: Story = { args: { scenario: 'changed-scale' } };
export const RetiredTarget: Story = { args: { scenario: 'retired-target' } };
export const ConcealedContext: Story = { args: { scenario: 'concealed' } };
