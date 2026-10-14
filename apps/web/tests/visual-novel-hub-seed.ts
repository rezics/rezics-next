import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { seedPartlessWork } from './partless-progress-seed.ts';

export interface VisualNovelHubFixture {
  work: string;
  title: string;
  releases: { title: string; platform: string }[];
}

const run = process.env.REZICS_QA_RUN_ID ?? '';
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(run)) throw new Error('Use an isolated browser QA run');
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!authPath || !objectDirectory) throw new Error('The running stack and browser member are required');
const reader = JSON.parse(readFileSync(authPath, 'utf8')) as { principalId: string; actingSubject: string };
const stack = await startMediaStack('visual-novel-hub-e2e', { library: true });
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const work = await seedPartlessWork(stack, { principalId: reader.principalId, actor: reader.actingSubject });
  const editor = await stack.member('visual-novel-editions');
  await editor.grant(`work:edit:${work.work}`, 'work.edit');
  await editor.grant(`work:read:${work.work}`, 'work.read');
  const short = (iri: string) => iri.slice(-36);
  const native = () => `https://rezics.com/id/${randomUUID()}`;
  const answer = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await editor.send('PUT', path, body);
    const text = await response.text();
    if (response.status !== 200) throw new Error(`PUT ${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const realization = native();
  const { revision } = await answer<{ revision: string }>(`/v1/works/${short(work.work)}/realizations/${short(realization)}`, {
    profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: editor.actor,
    language: 'en', kind: 'original', translators: [], publishers: [],
    source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: native(),
  });
  const releases: VisualNovelHubFixture['releases'] = [];
  for (const platform of ['Windows', 'Linux']) {
    const id = native();
    const title = `${work.title} ${platform}`;
    await answer(`/v1/works/${short(work.work)}/releases/${short(id)}`, {
      profile: 'release-v2', id, expectedHead: null, actingSubject: editor.actor, kind: 'formal', status: 'official',
      titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
      editionStatement: null, publisher: 'Paper Cranes Studio', publicationYear: 2026, isbn13: null,
      originalUrl: null, fixedRelease: null, identifiers: [], platform, territory: null,
      coverage: [{ realization, revision, completeness: 'complete' }], evidence: null,
    });
    releases.push({ title, platform });
  }
  const directory = resolve('.temp/visual-novel-hub', run);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'seed.json'), JSON.stringify({ ...work, releases } satisfies VisualNovelHubFixture));
} finally {
  await stack.stop();
}
