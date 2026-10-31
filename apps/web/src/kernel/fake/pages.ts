import defaultFixtures from '../fixtures.json' with { type: 'json' };
import { pageRead, type Fixtures, type KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import { isRecord, languageList, localizeRecording, localizeSearchReads } from './languages.ts';
import { isCommunityPageTarget } from './subject-community.ts';
import { subjectSourcesPage } from './subject-sources.ts';

const storyFixtures = defaultFixtures as unknown as Fixtures;
const missingSubjectId = '00000000-0000-4000-8000-000000000000';

async function input(request: Request): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  return isRecord(value) ? value : undefined;
}

function storyPage(
  body: Record<string, unknown>,
  recordings: Record<string, KernelRecording>,
): KernelRecording | undefined {
  const target = isRecord(body.target) ? body.target : undefined;
  if (!target || (target.view !== undefined && target.view !== 'overview')) return undefined;
  if (target.route === '/') return recordings['home-page'];
  if (typeof target.subject === 'string') {
    if (target.subject === missingSubjectId) return recordings['missing-subject-page'];
    const subjectPage = recordings['subject-page'];
    return subjectPage?.subject === target.subject ? subjectPage : undefined;
  }
  if (typeof target.account === 'string')
    return Object.entries(recordings).find(
      ([name, recording]) => name.startsWith('agent-page') && recording.handle === target.account,
    )?.[1];
  return undefined;
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request, recordings }) => {
      const body = await input(request);
      const languages = languageList(body?.languages);
      // Select explicit Sources scenarios here, before the ordinary subject and hero recordings can answer.
      const recording =
        body && languages.length > 0
          ? (subjectSourcesPage(body) ?? (isCommunityPageTarget(body.target) ? undefined : storyPage(body, recordings)))
          : undefined;
      return recording ? localizeSearchReads(recording, languages, storyFixtures) : undefined;
    },
    fixture: async ({ request, fixtures }) => {
      const body = await input(request);
      const languages = languageList(body?.languages);
      if (languages.length === 0) return undefined;
      if (body && isCommunityPageTarget(body.target) && !subjectSourcesPage(body)) return undefined;
      const response = await pageRead(fixtures, request.clone() as Request);
      const value: unknown = await response.json().catch(() => undefined);
      if (!isRecord(value)) return { status: response.status };
      return localizeSearchReads({ ...value, status: response.status }, languages, fixtures);
    },
  },
];
