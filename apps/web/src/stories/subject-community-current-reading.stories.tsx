import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { readSubjectCommunity, type CommunityKind, type SubjectCommunity } from '../features/pages/subject-community';
import type { CommunityCard } from '../features/pages/subject-community-card';
import { SubjectCommunityContext, SubjectCommunityRegion } from '../features/pages/subject-community-view';
import { GLOBAL } from '../features/pages/subject-ratings';
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

type Scenario = 'anonymous' | 'member' | 'writer' | 'zero' | 'changed-scale' | 'retired-target' | 'concealed';
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
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!url.pathname.endsWith('/threads')) return fallback(input, init);
        if (scenario === 'concealed') return Response.json({ code: 'not_found' }, { status: 404 });
        const thread = communityThread(kind);
        const post = thread.firstPost;
        if (!('body' in post)) throw new Error('Expected an available opening');
        const recorded = {
          questionId: '01a1a000-0000-7000-8000-000000000085',
          units: scenario === 'zero' ? 0 : 14,
          revision: 2,
        };
        post.voteCitation = kind === 'review' ? recorded : null;
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
        const native = {
          ...thread,
          card,
          ...(scenario === 'changed-scale'
            ? { reviewContext: { citation: { state: 'available', units: 5, question: { scale: { min: 1, max: 5 } } } } }
            : {}),
        };
        return Response.json(communityThreadPage(kind, communitySubject, [native], null, place));
      },
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
            />
          </div>
        </PatternStory>
      </SubjectCommunityContext.Provider>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Patterns/Subject Community/Current Reading',
  component: CurrentCommunityReading,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CurrentCommunityReading>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Anonymous: Story = { args: { scenario: 'anonymous' } };
export const Member: Story = { args: { scenario: 'member', kind: 'discussion' } };
export const Writer: Story = { args: { scenario: 'writer' } };
export const Zero: Story = { args: { scenario: 'zero' } };
export const ChangedScale: Story = { args: { scenario: 'changed-scale' } };
export const RetiredTarget: Story = { args: { scenario: 'retired-target' } };
export const ConcealedContext: Story = { args: { scenario: 'concealed' } };
