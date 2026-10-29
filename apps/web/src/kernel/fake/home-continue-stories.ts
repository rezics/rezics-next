import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

type ContinueStory = 'one' | 'few' | 'many' | 'none';
let selected: ContinueStory = 'few';

export function setHomeContinueStory(value: ContinueStory): void {
  selected = value;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/libraryEntries',
    story: ({ recordings }) => {
      if (selected === 'few') return undefined;
      const source = recordings['library-continue-entries'];
      const values = source?.libraryEntries;
      if (!source || !Array.isArray(values)) return undefined;
      if (selected === 'none') return { ...source, libraryEntries: [] };
      if (selected === 'one') return { ...source, libraryEntries: values.slice(0, 1) };
      const first = values[0] as Record<string, unknown> | undefined;
      if (!first) return undefined;
      const base = Number.parseInt(String(first.subjectId).slice(-2), 10) || 1;
      const entries: Record<string, unknown>[] = [];
      for (let index = 0; index < 9; index += 1) {
        const subjectId = `0192f3a0-6c1e-7b2a-9d4e-${String(base + index).padStart(12, '0')}`;
        const subject = first.subject as Record<string, unknown> | undefined;
        entries.push({
          ...first,
          subjectId,
          subject: subject ? { ...subject, id: subjectId, label: `Continue story ${index + 1}` } : undefined,
        });
      }
      return { ...source, libraryEntries: entries } as KernelRecording;
    },
  },
];
