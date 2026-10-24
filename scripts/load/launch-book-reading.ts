import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gutenbergBooks } from '../../tests/fixtures/sources/gutenberg.ts';
import type { FixtureLock } from '../fixtures/pull.ts';
import { classicText } from '../dev/seed/classics-text.ts';
import { publishClassicChapters } from '../dev/seed/classics-text-step.ts';
import { stableId } from '../dev/seed/state.ts';
import type { SeedApi } from '../dev/seed/api.ts';
import { importedRightsAssessments } from '../../services/main/src/modules/rights/import-policy.ts';
import type { CorpusApi } from './work-profile-corpus.ts';

const root = resolve(import.meta.dir, '../..');
const short = (id: string) => id.slice(-36);

/** Native reading commands inside the launch owner's existing, single backup lifetime. */
export async function prepareLaunchBookReading(input: {
  api: CorpusApi; actor: string; token: string;
  book: { work: string; mainVersion: string; workRevision: string };
  authorize(scope: string, action: string): Promise<void>;
  signal: AbortSignal;
}) {
  const { api, actor, book, signal, authorize } = input;
  const key = `launch-reading:${short(book.work)}`;
  const lock = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
  const entry = lock.entries.find(item => item.source === 'gutenberg' && item.id === 'pg1342');
  if (!entry) throw new Error('Missing locked Pride and Prejudice source');
  const { fixture, chapters } = classicText(root, gutenbergBooks[0]);
  const descriptionFile = 'tests/fixtures/seeds/open-library/dd0fa391ab9fe17e0c22fdc272215be29a815eeadc9bba709b1e88c2ae56469b.json';
  const bytes = readFileSync(resolve(root, descriptionFile));
  const descriptionDigest = createHash('sha256').update(bytes).digest('hex');
  if (descriptionDigest !== 'dd0fa391ab9fe17e0c22fdc272215be29a815eeadc9bba709b1e88c2ae56469b')
    throw new Error('Open Library description source changed');
  const record = JSON.parse(bytes.toString('utf8')) as { description: string | { value: string }; authors: unknown[] };
  const sourceDescription = typeof record.description === 'string' ? record.description : record.description?.value;
  if (!sourceDescription || !JSON.stringify(record.authors).includes('/authors/OL21594A') || !sourceDescription.includes('Jane Austen'))
    throw new Error('The locked Book description or author correspondence is missing');
  // Header descriptions are plain text fields. Keep the frozen paragraph bytes
  // in their source file and record the whitespace-only presentation transform.
  const description = sourceDescription.replace(/\s+/g, ' ').trim();
  for (const [index, assessment] of importedRightsAssessments({ provider: 'open-library',
    url: 'https://openlibrary.org/works/OL66554W' }, book.work, true)
    .filter(assessment => assessment.material.component === 'synopsis').entries()) {
    const assessmentKey = `${key}:description-rights:${index}`;
    await api.command(assessmentKey, { method: 'POST', path: '/v1/rights/use-assessments', body: {
      profile: 'rights-use-assessment-v1', actingSubject: actor, ...assessment, idempotencyKey: assessmentKey,
    } }, signal);
  }
  const metadata = await api.read<{ revision: string }>(`/v1/works/${short(book.work)}/metadata?actingSubject=${encodeURIComponent(actor)}`, signal);
  await api.command(`${key}:description`, { method: 'PUT', path: `/v1/works/${short(book.work)}/metadata`, body: {
    profile: 'work-metadata-details-v1', expectedHead: metadata.revision, actingSubject: actor,
    state: { kind: 'header', originalTitle: { value: 'Pride and Prejudice', language: 'en' },
      localized: [{ language: 'en', title: 'Pride and Prejudice', description, mainVersionLabel: null }] },
  } }, signal);
  const author = await api.command<{ agent: string }>(`${key}:author`, { method: 'POST', path: '/v1/agents', body: {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Jane Austen',
  } }, signal);
  const current = await api.read<{ revision: string }>(`/v1/works/${short(book.work)}?actingSubject=${encodeURIComponent(actor)}`, signal);
  await api.command(`${key}:author-credit`, { method: 'POST', path: `/v1/works/${short(book.work)}/agent-credits`, body: {
    profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${stableId(`${key}:author-credit`)}`,
    agent: author.agent, role: 'author', expectedWorkHead: current.revision, actingSubject: actor,
  } }, signal);

  // This introduction is newly authored catalogue prose. Gutenberg chapter bytes
  // use the distinct public-domain Content protocol below, never original rights.
  await authorize(`contribution:create:${book.work}`, 'contribution.create');
  const introduction = 'This reading edition brings together Jane Austen’s Pride and Prejudice, its opening chapters and the recorded publication editions for choosing a copy.';
  const draft = await api.command<{ contribution: string; draftRevision: string }>(`${key}:introduction`, {
    method: 'POST', path: '/v1/contributions', body: { profile: 'text-contribution-v1', work: book.work,
      language: 'en', body: introduction, actingSubject: actor },
  }, signal);
  await authorize(`contribution:read:${draft.contribution}`, 'contribution.read');
  await authorize(`contribution:publish:${draft.contribution}`, 'contribution.publish');
  const publication = await api.command<{ publicationDecision: string }>(`${key}:introduction-publication`, {
    method: 'POST', path: '/v1/contribution-publications', body: { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor },
  }, signal);
  await authorize(`publication:select:${book.mainVersion}`, 'publication.select');
  const selection = await api.command(`${key}:main-selection`, { method: 'POST', path: '/v1/publication-selections', body: {
    profile: 'main-default-selection-v1', work: book.work, contribution: draft.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: book.mainVersion }, selectionBasis: 'main-maintainer', actingSubject: actor,
  } }, signal);
  const source = { provider: 'project-gutenberg' as const, identifier: 'ebook/1342', url: entry.requestUrl,
    byteDigest: fixture.sourceSha256, retrievedAt: entry.fetchedAt };
  const post: SeedApi['post'] = (path, body, _token, commandKey) => {
    if (!path.startsWith('/v1/')) throw new Error('Classic command escapes the native API');
    return api.command(commandKey, { method: 'POST', path: path as `/v1/${string}`, body }, signal);
  };
  await publishClassicChapters({ api: { post }, target: book, book: 'pride', actor, token: input.token,
    chapters, source, fixtureDigest: entry.sha256, grant: async work => {
      for (const [prefix, action] of [['work:read', 'work.read'], ['content:draft', 'content.draft'],
        ['content:publish', 'content.publish'], ['content:search-eligibility', 'content.search-eligibility']] as const)
        await authorize(`${prefix}:${work}`, action);
    } });
  const reader = `actingSubject=${encodeURIComponent(actor)}`;
  const header = await api.read(`/v1/works/${short(book.work)}?language=en&${reader}`, signal);
  const contents = await api.read(`/v1/works/${short(book.work)}/contents?language=en&limit=20&${reader}`, signal);
  return { description: { value: description, sourceValue: sourceDescription,
    transformation: 'collapse-whitespace', file: descriptionFile, sha256: descriptionDigest }, author,
    mainText: { introduction, draft, publication, selection }, source, fixture: { file: entry.seed, sha256: entry.sha256 },
    chapters, header, contents };
}
