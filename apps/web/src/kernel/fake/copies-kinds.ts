import type { FakeRoute } from '../fake-modules';
import recording from '../recorded/library-copies.json';
import definitions from '../recorded/definitions-release.json';

type Copy = {
  id: string;
  kind: string | null;
  status: string;
  revision: number;
  subject?: { id: string };
  [key: string]: unknown;
};
let scenario: { copies: Copy[]; refusal?: boolean } | undefined;
let story = false;
export function resetCopyProfileScenario() {
  scenario = undefined;
}
export function setCopyProfileScenario(next: { copies: Copy[]; refusal?: boolean }) {
  scenario = structuredClone(next);
}
export function resetCopyKindsStory() {
  story = false;
}
export function setCopyKindsStory(retired = false) {
  story = true;
  setCopyProfileScenario({
    copies: recording.copies
      .slice(0, 1)
      .map((copy) => ({ ...copy, kind: retired ? null : 'print', status: retired ? 'unknown' : 'shelf' })),
  });
}
const profile = {
  copies: {
    kinds: [
      {
        id: 'print',
        labels: { en: 'Print', ja: '紙の本', de: 'Druckausgabe' },
        statuses: [
          { id: 'shelf', labels: { en: 'On shelf', ja: '本棚にある', de: 'Im Regal' } },
          { id: 'loan', labels: { en: 'On loan', ja: '貸出中', de: 'Verliehen' } },
        ],
      },
      {
        id: 'digital',
        labels: { en: 'Digital', ja: '電子書籍', de: 'Digital' },
        statuses: [{ id: 'available', labels: { en: 'Available', ja: '利用可能', de: 'Verfügbar' } }],
      },
    ],
  },
};
const answer = async ({ request }: { request: Request }) => {
  if (!scenario) return;
  const path = new URL(request.url).pathname;
  if (request.method === 'GET') return { status: 200, copies: scenario.copies, next: null };
  if (scenario.refusal && request.method !== 'DELETE')
    return { status: 422, code: 'unsupported_library_profile', effect_status: 'not_applied' };
  if (request.method === 'DELETE') {
    scenario.copies = scenario.copies.filter((copy) => copy.id !== path.split('/').at(-1));
    return { status: 200 };
  }
  const body = (await request.json()) as Record<string, unknown>;
  if (request.method === 'PATCH') {
    if ('kind' in body) return { status: 400, code: 'invalid_request' };
    const current = scenario.copies.find((copy) => copy.id === path.split('/').at(-1));
    return { status: 200, copy: { ...current, ...body, revision: Number(body.revision) + 1 } };
  }
  if (!body.kind) return { status: 400, code: 'invalid_request' };
  if (
    !profile.copies.kinds.some(
      (kind) => kind.id === body.kind && kind.statuses.some((status) => status.id === body.status),
    )
  )
    return { status: 422, code: 'unsupported_library_profile', effect_status: 'not_applied' };
  const copy = { ...body, id: crypto.randomUUID(), revision: 1 } as Copy;
  scenario.copies.push(copy);
  return { status: 201, copy };
};
export const routes: FakeRoute[] = [
  ...['GET', 'POST', 'PATCH', 'DELETE'].map((method) => ({
    method,
    path: /^\/v1\/copies(?:\/[^/]+)?$/,
    fixture: answer,
    story: (context: Parameters<typeof answer>[0]) => (story ? answer(context) : undefined),
  })),
  {
    method: 'GET',
    path: '/v1/definitions/active',
    story: () => (story ? { status: 200, digest: 'copy-kinds-story' } : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/definitions\/releases\//,
    story: () =>
      story
        ? {
            status: 200,
            ...definitions,
            digest: 'copy-kinds-story',
            release: {
              ...definitions.release,
              libraryProfiles: { ...definitions.release.libraryProfiles, 'book.reading': profile },
            },
          }
        : undefined,
  },
];
