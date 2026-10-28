import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';

const offerId = /^\/v1\/offers\/([^/]+)$/;
const orderId = /^\/v1\/orders\/([^/]+)$/;

function demoSubjectLabels(recordings: Record<string, KernelRecording>): Record<string, string> | undefined {
  const subject = recordings.subject?.subject;
  if (!subject || typeof subject !== 'object') return;
  const labels = (subject as Record<string, unknown>).labels;
  return labels && typeof labels === 'object' ? (labels as Record<string, string>) : undefined;
}

function localizedSubject(
  recording: Record<string, unknown>,
  locale: string,
  labels: Record<string, string> | undefined,
): Record<string, unknown> | undefined {
  const value = labels?.[locale] ?? labels?.en;
  if (typeof value !== 'string' || !recording.subject || typeof recording.subject !== 'object') return;
  return {
    ...recording,
    subject: { ...(recording.subject as Record<string, unknown>), label: { value, language: locale } },
  };
}

/** Story offers receive the same localized subject label as the subject read for this demo subject. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: offerId,
    story: ({ request, recordings, match }) => {
      if (!match) return;
      const id = decodeURIComponent(match[1]!);
      const recording = Object.values(recordings).find((candidate) => {
        const offer = candidate.offer;
        return !!offer && typeof offer === 'object' && (offer as Record<string, unknown>).id === id;
      });
      if (!recording?.offer || typeof recording.offer !== 'object') return;
      const offer = recording.offer as Record<string, unknown>;
      const labels = demoSubjectLabels(recordings);
      const locale = new URL(request.url).searchParams.get('languages') ?? 'en';
      const localized = localizedSubject(offer, locale, labels);
      if (!localized) return;
      return {
        ...recording,
        offer: localized,
      };
    },
  },
  {
    method: 'GET',
    path: orderId,
    story: ({ request, recordings, match }) => {
      if (!match) return;
      const id = decodeURIComponent(match[1]!);
      const recording = Object.values(recordings).find((candidate) => {
        const order = candidate.order;
        return !!order && typeof order === 'object' && (order as Record<string, unknown>).id === id;
      });
      if (!recording?.order || typeof recording.order !== 'object') return;
      const labels = demoSubjectLabels(recordings);
      const locale = new URL(request.url).searchParams.get('languages') ?? 'en';
      const localized = localizedSubject(recording.order as Record<string, unknown>, locale, labels);
      return localized ? ({ ...recording, order: localized } as KernelRecording) : undefined;
    },
  },
];
