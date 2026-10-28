import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

type PageRecording = KernelRecording & {
  reads?: Record<string, { body?: { subject?: { aliases?: Record<string, string[]> } } }>;
};

/** Long alternate names and an existing spoiler make the hero's narrow layout visible in page stories. */
export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request, recordings }) => {
      let subjectId: unknown;
      try {
        const body = (await request.json()) as { target?: { subject?: unknown } };
        subjectId = body.target?.subject;
      } catch {
        return;
      }
      const recording = recordings['subject-page'] as PageRecording | undefined;
      if (!recording || typeof subjectId !== 'string' || subjectId !== recording.subject) return;

      const page = structuredClone(recording) as PageRecording;
      const subjectRead = Object.values(page.reads ?? {}).find((read) => read.body?.subject);
      const subject = subjectRead?.body?.subject;
      if (!subject) return;
      subject.aliases = {
        en: [
          'The Little Prince, translated from the French title Le Petit Prince',
          'A very long alternate title that wraps within the value column on narrow screens',
          'The prince who travelled between small planets and met a pilot in the desert',
        ],
        ja: ['星の王子さまの長い別名と別表記'],
        'zh-Hans': ['小王子的长篇别名和其他译名'],
        'zh-Hant': ['小王子的長篇別名與其他譯名'],
      };
      return page;
    },
  },
];
