import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import { isRecord } from './languages.ts';

const ids = [
  '00000000-0000-4000-8000-000000000761',
  '00000000-0000-4000-8000-000000000762',
  '00000000-0000-4000-8000-000000000763',
];
const questionId = '00000000-0000-7000-8000-000000000001';
const globalPopulationId = '00000000-0000-8000-8000-000000000000';

function rating(subjectId: string, score: number) {
  return {
    questionId,
    populationId: globalPopulationId,
    subjectId,
    count: 27,
    mean: score,
    score,
    priorEpoch: null,
    revision: 'story-global-score-v1',
    asOf: '2026-10-27T00:00:00Z',
  };
}

const stories: KernelRecording = {
  status: 200,
  subjects: [
    {
      id: ids[0],
      type: 'schema:Book',
      labels: { en: 'Kokoro', 'zh-Hans': '心' },
      descriptions: { en: 'A classic novel by Natsume Soseki.', 'zh-Hans': '夏目漱石的经典小说。' },
      publicRating: rating(ids[0]!, 8.6),
      storyOverlay: true,
    },
    {
      id: ids[1],
      type: 'schema:Book',
      labels: { en: 'The Little Prince', 'zh-Hans': '小王子' },
      descriptions: {
        en: 'A pilot meets a young visitor from another world.',
        'zh-Hans': '飞行员遇见来自另一个世界的小小访客。',
      },
      publicRating: rating(ids[1]!, 8.1),
    },
    {
      id: ids[2],
      type: 'schema:Book',
      labels: { en: 'An Unscored Story', 'zh-Hans': '尚无评分的故事' },
      descriptions: { en: 'No public score has been published.', 'zh-Hans': '尚未发布公开评分。' },
    },
  ],
  next: null,
  as_of: '2026-10-27T00:00:00Z',
};

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/subjects:search',
    story: async ({ request }) => {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      return isRecord(body) && body.sort === 'rating' ? structuredClone(stories) : undefined;
    },
  },
];
