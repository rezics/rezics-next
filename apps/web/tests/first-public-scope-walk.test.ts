import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_CONTEXT } from '../../../services/importer/src/ordinary-owner-grants.ts';
import { seedCommunityEntities } from '../scripts/first-public-scope-fixture.ts';
import { selectFirstPublicPaths } from '../scripts/first-public-scope-walk.ts';
import type { KernelCall } from '../scripts/semantic-first-public-native.ts';
import { FIRST_PUBLIC_SCOPE_PATHS } from '../scripts/first-public-scope-paths.ts';

const capabilities = resolve(import.meta.dir, '../../../docs/goals/web.capabilities.md');
const stackHost = resolve(import.meta.dir, './native/stack.host.test.ts');
const authHost = resolve(import.meta.dir, './native/auth-stack.host.test.ts');
const identityHost = resolve(import.meta.dir, './native/native-agent-identity.host.test.ts');
const interruptHost = resolve(import.meta.dir, './native/web-publication-interrupt.host.test.ts');

test('the first-public-scope walk retains in-scope IDs and names the required Book and knowledge journeys', () => {
  expect(FIRST_PUBLIC_SCOPE_PATHS).toHaveLength(36);
  expect(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.id)).toEqual(
    Array.from({ length: 38 }, (_, index) => `W${String(index + 1).padStart(2, '0')}`).filter(
      (id) => id !== 'W27' && id !== 'W28',
    ),
  );
  expect(new Set(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.job)).size).toBe(36);
  expect(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.job).join(' ')).not.toMatch(
    /checkout|payment|Orders or entitlements/,
  );
});

test('the walk retains the original native host suites and does not import Auth contract', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/first-public-scope-walk.ts'), 'utf8');
  expect(source).toContain("from './first-public-scope-paths.ts'");
  expect(source).not.toMatch(/from ['"]@rezics\/auth-contract['"]/);
  expect(readFileSync(stackHost, 'utf8')).toContain('startNativeWebStack');
  expect(readFileSync(authHost, 'utf8')).toContain('startAuthStack');
  expect(readFileSync(identityHost, 'utf8')).toContain('createNativeAgentIdentityFixture');
  expect(readFileSync(interruptHost, 'utf8')).toContain('createWebPublicationDriver');
});

test('historical web.capabilities evidence retains every original active path', () => {
  const text = readFileSync(capabilities, 'utf8');
  const rows = text.split('\n').map((line) => line.split('|').map((cell) => cell.trim()));
  for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
    if (path.id === 'W36' || path.id === 'W37' || path.id === 'W38') continue;
    const matches = rows.filter((cells) => cells[1] === path.id);
    expect(matches).toHaveLength(1);
    expect(['PASS', 'FAIL-unreached', 'FAIL']).toContain(matches[0]![5]);
  }
});

test('external paths retain their exact native/browser suites without claiming a seeded-walk pass', () => {
  const external = FIRST_PUBLIC_SCOPE_PATHS.flatMap((path) => ('nativeHost' in path ? [path] : []));
  expect(external.map(({ id, nativeHost }) => [id, nativeHost])).toEqual([
    ['W14', 'tests/native/first-public-personal.host.test.ts'],
    ['W15', 'tests/native/first-public-personal.host.test.ts'],
    ['W16', 'tests/native/native-curated-collections.host.test.ts'],
    ['W17', 'tests/native/first-public-personal.host.test.ts'],
    ['W19', 'tests/native/first-public-personal.host.test.ts'],
    ['W20', 'tests/native/first-public-personal.host.test.ts'],
    ['W21', 'tests/native/native-following.host.test.ts'],
    ['W22', 'tests/native/native-auth-security.host.test.ts'],
    ['W23', 'tests/native/external-client-consent.host.test.ts'],
    ['W24', 'tests/native/native-auth-security.host.test.ts'],
    ['W25', 'tests/native/first-public-personal.host.test.ts'],
    ['W26', 'tests/native/private-library-archive-restore.host.test.ts'],
    ['W30', 'tests/native/subject-rating.host.test.ts'],
    ['W32', 'tests/native/native-moderation.host.test.ts'],
    ['W33', 'tests/native/native-notifications.host.test.ts'],
    ['W36', 'tests/native/book-catalogue-journey.host.test.ts'],
    ['W37', 'tests/native/hosted-book-journey.host.test.ts'],
    ['W38', 'tests/native/knowledge-journey.host.test.ts'],
  ]);
  for (const path of external) {
    const source = readFileSync(resolve(import.meta.dir, '..', path.nativeHost), 'utf8');
    if (path.nativeHost === 'tests/native/first-public-personal.host.test.ts') expect(source).toContain(`'${path.id} `);
    if (path.id === 'W36' || path.id === 'W37' || path.id === 'W38') {
      expect(source).toContain('nativeTest(');
      expect(source).toContain('nativeBeforeAll(');
    }
  }
  const walk = readFileSync(resolve(import.meta.dir, '../scripts/first-public-scope-walk.ts'), 'utf8');
  expect(walk).toContain("if ('nativeHost' in path)");
  expect(walk).toContain('acceptanceCommand');
  expect(walk).toContain('This seeded walk has no walker for this required journey');
  expect(walk).toContain("results.some((row) => row.status !== 'PASS')");
  expect(walk).not.toContain('${passing}/35');
});

test('the walk requires the admitted Web fixture and stops on incomplete catalogue seeding', () => {
  const walk = readFileSync(resolve(import.meta.dir, '../scripts/first-public-scope-walk.ts'), 'utf8');
  expect(walk).toContain('!firstPublicWebWalk()');
  expect(walk).toContain('!walkStackAdmitted(process.env, root)');
  expect(walk).toContain("'--dev-catalogue', '--without-person-merge'");
  expect(walk).toContain('if (seedCode !== 0) throw');
  expect(walk).not.toContain("'persona'");
  expect(walk).not.toContain("'--dev'");
});

test('community selects only the Board and Realm journeys, with every other path explicitly unselected', () => {
  const all = selectFirstPublicPaths([]);
  expect(all.scope).toBe('all');
  expect(all.paths).toEqual(FIRST_PUBLIC_SCOPE_PATHS);
  expect(all.unselected).toEqual([]);

  const community = selectFirstPublicPaths(['--scope', 'community']);
  expect(community.scope).toBe('community');
  expect(community.paths.map(({ id }) => id)).toEqual(['W29', 'W31']);
  expect(community.unselected).toEqual(all.paths.map(({ id }) => id).filter((id) => id !== 'W29' && id !== 'W31'));
  expect(() => selectFirstPublicPaths(['--scope', 'catalogue'])).toThrow('Usage:');
  expect(() => selectFirstPublicPaths(['--scope'])).toThrow('Usage:');
});

const fixtureId = (tail: number) => `00000000-0000-8000-8000-${String(tail).padStart(12, '0')}`;

test.each([undefined, fixtureId(9)])(
  'community entities keep the exact authored Concept and opening context (%s)',
  async (workId) => {
    const [accountId, conceptId, boardId, threadId, openingPostId, openingRevisionId, spaceId, realmId] = [
      1, 2, 3, 4, 5, 6, 7, 8,
    ].map(fixtureId);
    const bearer = 'ordinary-owner';
    const title = 'First-public Web Discussion';
    const subject = { id: conceptId, type: 'skos:Concept', labels: { en: title }, revision: 1 };
    const board = {
      id: boardId,
      realmId: null,
      title,
      purpose: 'discussion',
      visibility: 'published',
      availability: 'available',
    };
    const subjectIds = [workId ?? conceptId];
    const spaceAddress = 'web-space';
    const thread = {
      id: threadId,
      boardId,
      kind: 'discussion',
      firstPost: {
        id: openingPostId,
        revisionId: openingRevisionId,
        authorId: accountId,
        licence: 'CC-BY-4.0',
        sha256: 'a'.repeat(64),
        subjectIds,
      },
    };
    const realm = { realmId, spaceId, visibility: 'public' };
    const requests = [
      ['POST', '/v1/subjects', bearer, { type: subject.type, labels: subject.labels }, 201, { subject }],
      ['GET', `/v1/subjects/${conceptId}`, undefined, undefined, 200, { subject }],
      [
        'POST',
        '/v1/boards',
        bearer,
        { conceptId, title, purpose: 'discussion', visibility: 'published' },
        201,
        { board },
      ],
      ['GET', '/v1/boards', undefined, undefined, 200, { boards: [board] }],
      [
        'POST',
        '/v1/threads',
        bearer,
        {
          boardId,
          kind: 'discussion',
          title: 'A note for the first-public discussion',
          licence: 'CC-BY-4.0',
          visibility: 'published',
          subjectIds,
          body: expect.objectContaining({ version: 'rezics-document-v1', profile: 'text' }),
        },
        201,
        { thread },
      ],
      ['POST', '/v1/spaces', bearer, { title: 'First-public Web Space' }, 201, { space: { spaceId } }],
      [
        'POST',
        '/v1/realms',
        bearer,
        { spaceId, title: 'First-public Web Realm', visibility: 'public', contextId: GLOBAL_CONTEXT },
        201,
        { realm },
      ],
      [
        'GET',
        `/v1/spaces/${spaceId}`,
        undefined,
        undefined,
        200,
        { space: { spaceId, realmId, address: spaceAddress } },
      ],
    ] as const;
    let index = 0;
    const call: KernelCall = async (method, path, options) => {
      const [verb, target, credential, body, status, response] = requests[index++]!;
      expect([method, path, options?.bearer]).toEqual([verb, target, credential]);
      expect(options?.body).toEqual(body);
      if (path === '/v1/boards' && method === 'GET')
        expect(options?.query).toEqual({ purpose: 'discussion', limit: '100' });
      return { status, headers: new Headers(), body: response };
    };
    expect(await seedCommunityEntities(call, bearer, accountId!, workId)).toEqual({
      conceptId,
      boardId,
      threadId,
      openingPostId,
      openingRevisionId,
      spaceId,
      spaceAddress,
      realmId,
    });
    expect(index).toBe(requests.length);
  },
);

test('a different anonymous Subject stops the community fixture before Board creation', async () => {
  const id = fixtureId(2);
  const subject = { id, type: 'skos:Concept', labels: { en: 'First-public Web Discussion' }, revision: 1 };
  const calls: string[] = [];
  const call: KernelCall = async (method, path) => {
    calls.push(`${method} ${path}`);
    return {
      status: method === 'POST' ? 201 : 200,
      headers: new Headers(),
      body: { subject: method === 'POST' ? subject : { ...subject, id: fixtureId(3) } },
    };
  };
  await expect(seedCommunityEntities(call, 'ordinary-owner', fixtureId(1))).rejects.toThrow('Public Board Concept');
  expect(calls).toEqual(['POST /v1/subjects', `GET /v1/subjects/${id}`]);
});
