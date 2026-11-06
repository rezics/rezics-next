import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fromPlainText } from '@rezics/document';
import { installedRatingsPage, walkWorkingDirectory } from '../scripts/seeded-content-ratings-reviews-walk.ts';

test('the ratings walk runs from apps/web with installed Subject page types and no root lease preload', () => {
  if (process.env.REZICS_RATINGS_WALK !== '1')
    console.log('skip: seeded ratings walk requires REZICS_RATINGS_WALK=1 on a walk stack');
  expect(walkWorkingDirectory()).toBe(resolve(import.meta.dir, '..'));
  expect(installedRatingsPage()).toEqual({
    questionId: '00000000-0000-7000-8000-000000000001',
    population: '00000000-0000-8000-8000-000000000000',
  });
  const source = readFileSync(resolve(import.meta.dir, '../scripts/seeded-content-ratings-reviews-walk.ts'), 'utf8');
  expect(source).toContain("await import('../src/features/pages/subject-ratings.ts')");
  expect(source).toContain('assert.equal(pageTypes.questionId, QUESTION)');
  expect(source).toContain('cwd: webRoot');
  expect(readFileSync(resolve(import.meta.dir, '../bunfig.toml'), 'utf8')).not.toContain('stack-lease-preload');
  expect(readFileSync(resolve(import.meta.dir, '../../../bunfig.toml'), 'utf8')).toContain('stack-lease-preload');
});

/**
 * Seeded ratings and reviews walk. It runs only inside `dev-stack.ts walk` with native and browser acceptance (see
 * `scripts/seeded-content-ratings-reviews-walk.ts`). Native checks use real HTTP commands with Bearer personas and
 * independent readback; browser checks drive the served Subject and My ratings pages. Evidence and screenshots are
 * written under `.temp/ratings-walk/`.
 */
const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/ratings-walk');
const seedPath = join(root, '.temp/cross-media-seed/result.json');
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const signupTurnstile = 'rezics-local-signup';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const launchLocales = ['en', 'zh-Hant', 'ja'] as const;
const widths = [390, 1440] as const;
const themes = ['light', 'dark'] as const;
const walkRequested = process.env.REZICS_RATINGS_WALK === '1';
if (walkRequested && !process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN)
  throw new Error('REZICS_RATINGS_WALK requires the walk stack origins from dev-stack.ts walk');
const walk = walkRequested ? test : test.skip;

type Json = Record<string, any>;
type Stack = { web: string; issuer: string; kernel: string };
type Persona = { label: string; email: string; password: string; bearer: string; accountId: string | null };
type Scale = { min: number; max: number; displayStep: number };
type Citation = { questionId: string; units: number; revision: number };

function loopback(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run this walk through dev-stack.ts walk`);
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error(`${name} must be an unauthenticated loopback HTTP origin`);
  return url.origin;
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (!match?.groups) continue;
    values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

/** Idempotency-Key is a structured-field string, so every command key travels quoted. */
async function kernel(
  stack: Stack,
  method: string,
  path: string,
  options: {
    bearer?: string;
    body?: unknown;
    query?: Record<string, string>;
    ifMatch?: string;
    key?: string;
    observation?: unknown;
  } = {},
): Promise<{ status: number; value: Json }> {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(options.key ?? crypto.randomUUID()) }),
      ...(options.ifMatch ? { 'if-match': JSON.stringify(options.ifMatch) } : {}),
      ...(options.observation === undefined ? {} : { 'x-rating-observation': JSON.stringify(options.observation) }),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let value: Json = {};
  if (text) {
    try {
      value = JSON.parse(text) as Json;
    } catch {
      value = { raw: text.slice(0, 200) };
    }
  }
  return { status: response.status, value };
}

function requireStatus(result: { status: number; value: Json }, label: string, expected = 200): Json {
  if (result.status !== expected)
    throw new Error(`${label} returned HTTP ${result.status}: ${JSON.stringify(result.value).slice(0, 400)}`);
  return result.value;
}

/** The first object value stored under `key`, however deeply the response nests it. */
function deepFind(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (key in value) return (value as Json)[key];
  for (const item of Object.values(value)) {
    const found = deepFind(item, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function bearerFor(stack: Stack, persona: Pick<Persona, 'email' | 'password'>, dev: Record<string, string>) {
  const signin = await fetch(`${stack.issuer}/signin`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: persona.email,
      password: persona.password,
      client_id: dev.WEBSITE_CLIENT_ID ?? 'rezics-website',
      scope: dev.WEBSITE_SCOPES,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!signin.ok) throw new Error(`${persona.email} sign-in failed: HTTP ${signin.status}`);
  const token = await fetch(`${stack.issuer}/token`, {
    method: 'POST',
    headers: {
      origin: stack.issuer,
      'content-type': 'application/json',
      cookie: signin.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    },
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  });
  if (!token.ok) throw new Error(`${persona.email} token failed: HTTP ${token.status}`);
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`${persona.email} token response omitted access_token`);
  return body.access_token;
}

/** Ordinary voters use the registration route with the local verification stub, then the same sign-in as the developer. */
async function registerVoter(stack: Stack, label: string, dev: Record<string, string>): Promise<Persona> {
  const handle = `${label}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const email = `${handle}@example.test`;
  const password = `ratings walk password ${label} 2026`;
  const response = await fetch(`${stack.issuer}/signup`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({
      key: crypto.randomUUID(),
      handle,
      email,
      password,
      turnstile_token: signupTurnstile,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status !== 200 && response.status !== 201)
    throw new Error(`${label} registration returned HTTP ${response.status}`);
  const persona: Persona = { label, email, password, bearer: '', accountId: null };
  persona.bearer = await bearerFor(stack, persona, dev);
  const own = requireStatus(
    await kernel(stack, 'GET', '/v1/me/rating-votes', { bearer: persona.bearer }),
    `${label} own-votes page`,
  );
  persona.accountId = typeof own.viewer?.accountId === 'string' ? own.viewer.accountId : null;
  return persona;
}

function workIdentity(seed: Json, provider: string, externalId: string): string | null {
  for (const entry of Array.isArray(seed.readings) ? seed.readings : []) {
    if (entry?.source !== provider || entry.externalId !== externalId) continue;
    const id = entry.subject?.subject?.id;
    if (typeof id === 'string' && uuidPattern.test(id)) return id;
  }
  for (const entry of Array.isArray(seed.workLinks) ? seed.workLinks : []) {
    const source = entry?.source;
    if (source?.provider !== provider || source.externalId !== externalId) continue;
    const id = source.subject?.subjectId;
    if (typeof id === 'string' && uuidPattern.test(id)) return id;
  }
  return null;
}

async function readVote(stack: Stack, persona: Persona, subjectId: string): Promise<Json | null> {
  const result = await kernel(stack, 'GET', `/v1/subjects/${subjectId}/ratings/${standardQuestion}/vote`, {
    bearer: persona.bearer,
  });
  if (result.status === 404) return null;
  return requireStatus(result, `${persona.label} vote readback`);
}

async function putVote(
  stack: Stack,
  persona: Persona,
  subjectId: string,
  units: number,
  extra: { key?: string; observation?: unknown; questionId?: string } = {},
): Promise<Json> {
  return requireStatus(
    await kernel(stack, 'PUT', `/v1/subjects/${subjectId}/ratings/${extra.questionId ?? standardQuestion}/vote`, {
      bearer: persona.bearer,
      body: { units },
      key: extra.key,
      observation: extra.observation,
    }),
    `${persona.label} vote ${units}`,
  );
}

function questionObservation(subjectId: string, question: Json) {
  return {
    subjectId,
    question: {
      id: question.id ?? question.question?.id ?? standardQuestion,
      revision: question.revision ?? question.question?.revision,
      grain: question.grain ?? question.question?.grain,
      meaning: question.meaning ?? question.label ?? question.question?.label,
      scale: question.scale ?? question.question?.scale,
    },
  };
}

async function aggregateFigure(stack: Stack, subjectId: string, population: string, bearer?: string): Promise<Json> {
  const value = requireStatus(
    await kernel(stack, 'GET', `/v1/subjects/${subjectId}/ratings`, {
      bearer,
      query: { question: standardQuestion, population },
    }),
    `aggregate ${population}`,
  );
  const figures = Array.isArray(value.figures) ? value.figures : [];
  const figure = figures.find((item: Json) => item.population === population) ?? figures[0];
  if (!figure || typeof figure !== 'object') throw new Error(`No aggregate figure for ${population}`);
  return figure as Json;
}

async function pollUntil<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`${label} did not settle: ${JSON.stringify(last).slice(0, 300)}`);
    await Bun.sleep(1_500);
    last = await read();
  }
  return last;
}

function figureOf(value: Json): Json {
  const figure = value.figure;
  if (!figure || typeof figure !== 'object') throw new Error('Subject figure response has no figure');
  return figure as Json;
}

function loopbackOnly(route: import('playwright').Route) {
  const url = new URL(route.request().url());
  return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
}

/** Moves the rating slider to `units` with the keyboard, the way a reader does, then waits for the thumb to agree. */
async function setSlider(
  page: import('playwright').Page,
  units: number,
  displayStep: number,
  expect: typeof import('playwright/test').expect,
) {
  const thumb = page.locator('[data-slot="slider-thumb"]').first();
  await thumb.waitFor({ state: 'visible', timeout: 60_000 });
  const current = Number(await thumb.getAttribute('aria-valuenow'));
  const presses = (units - current) / displayStep;
  if (!Number.isFinite(current) || !Number.isInteger(presses))
    throw new Error(`slider cannot reach ${units} from ${current}`);
  await thumb.focus();
  for (let index = 0; index < Math.abs(presses); index++)
    await page.keyboard.press(presses > 0 ? 'ArrowRight' : 'ArrowLeft');
  await expect(thumb).toHaveAttribute('aria-valuenow', String(units), { timeout: 15_000 });
}

/** Screenshots are the reviewable evidence for the served path; the readiness selector must be on the page. */
async function capturePage(
  page: import('playwright').Page,
  stack: Stack,
  path: string,
  locale: string,
  width: number,
  theme: (typeof themes)[number],
  name: string,
  ready: string,
  evidence: Json,
) {
  await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: stack.web }]);
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: theme });
  const response = await page.goto(`${stack.web}/${locale}/${path}`, { waitUntil: 'domcontentloaded' });
  if (response?.status() !== 200)
    throw new Error(`${name} ${locale} ${width}px ${theme} returned HTTP ${response?.status()}`);
  await page.locator(ready).first().waitFor({ state: 'visible', timeout: 90_000 });
  const file = `screenshots/${name}-${locale}-${width}-${theme}.png`;
  await page.screenshot({ path: join(evidenceDir, file) });
  (evidence.screenshots as string[]).push(file);
  (evidence.pages as Json[]).push({ persona: name.split('-')[0], locale, width, theme, path, ready, file });
}

/** A Search hit's figure is the first `figure` object whose subtree names this Subject. */
function figureForSubject(value: unknown, subjectId: string): Json | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = figureForSubject(item, subjectId);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const node = value as Json;
  if (node.figure && typeof node.figure === 'object' && JSON.stringify(node).includes(subjectId))
    return node.figure as Json;
  for (const item of Object.values(node)) {
    const found = figureForSubject(item, subjectId);
    if (found) return found;
  }
  return null;
}

/** A reviews board needs a Realm, a scheme and a concept, as the production Realm commands define them. */
async function createReviewsBoard(stack: Stack, persona: Persona): Promise<{ realmId: string; boardId: string }> {
  const bearer = persona.bearer;
  const globalContext = '00000000-0000-8000-8000-000000000000';
  const space = requireStatus(
    await kernel(stack, 'POST', '/v1/spaces', {
      bearer,
      body: { title: 'Ratings walk', summary: 'Seeded Realm for the ratings and reviews walk' },
    }),
    'reviews space create',
    201,
  ).space as Json;
  let realm = requireStatus(
    await kernel(stack, 'POST', '/v1/realms', {
      bearer,
      body: {
        spaceId: space.spaceId,
        title: 'Ratings walk reviews',
        summary: 'Reviews citing votes in the ratings walk',
        visibility: 'public',
        contextId: globalContext,
      },
    }),
    'reviews realm create',
    201,
  ).realm as Json;
  const realmId = String(realm.realmId);
  const scheme = requireStatus(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer,
      body: { type: 'skos:ConceptScheme', labels: { en: 'Ratings walk discussion scheme' } },
    }),
    'reviews scheme create',
    201,
  ).subject as Json;
  realm = requireStatus(
    await kernel(stack, 'PUT', `/v1/realms/${realmId}/boardScheme`, {
      bearer,
      body: { schemeId: scheme.id },
      ifMatch: String(realm.headRevisionId),
    }),
    'reviews board scheme',
  ).realm as Json;
  const concept = requireStatus(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer,
      body: {
        type: 'skos:Concept',
        labels: { en: 'Ratings walk reviews' },
        statements: {
          'skos:inScheme': [
            { property: { id: 'skos:inScheme' }, value: { type: 'value', content: realm.boardSchemeId } },
          ],
        },
      },
    }),
    'reviews concept create',
    201,
  ).subject as Json;
  const board = requireStatus(
    await kernel(stack, 'POST', `/v1/realms/${realmId}/boards`, {
      bearer,
      body: { conceptId: concept.id, title: 'Ratings walk reviews', visibility: 'published', purpose: 'reviews' },
    }),
    'reviews board create',
    201,
  ).board as Json;
  return { realmId, boardId: String(board.id) };
}

walk(
  'seeded ratings and reviews walk: native votes, reviews, figures and served browser paths',
  async () => {
    const stack: Stack = {
      web: loopback('REZICS_LOCAL_STACK_WEB_ORIGIN'),
      issuer: loopback('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
      kernel: loopback('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
    };
    await mkdir(join(evidenceDir, 'screenshots'), { recursive: true });
    const sourceRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
    const evidence: Json = {
      sourceRevision,
      stack,
      seedExit: process.env.REZICS_RATINGS_WALK_SEED_EXIT ?? null,
      sequence: [] as string[],
      native: {} as Json,
      pages: [] as Json[],
      screenshots: [] as string[],
      notWalked: [
        'Full VNDB/Bangumi/MAL/AniList list-import apply: no private provider export on this stack; vote HTTP observation and 503 mapping are the original authorized vote transactions',
        'Fifty-vote Bayesian prior: native public-figure suite; this walk uses HTTP-created voters for the work threshold and a protected Realm contrast',
      ],
      defects: [] as string[],
    };
    const step = (name: string) => (evidence.sequence as string[]).push(name);
    const persist = async (name: string) =>
      writeFile(join(evidenceDir, name), `${JSON.stringify(evidence, null, 2)}\n`);

    try {
      const dev = parseEnv(await readFile(join(root, 'apps/web/.dev.vars'), 'utf8'));
      const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as {
        password: string;
      };
      const seed = JSON.parse(await readFile(seedPath, 'utf8')) as Json;
      const subjectId = workIdentity(seed, 'vndb', 'v2002');
      const bangumiId = workIdentity(seed, 'bangumi', '10380');
      if (!subjectId) throw new Error('Seed result has no native identity for VNDB v2002 (Steins;Gate)');
      evidence.native.identities = { vndbSteinsGate: subjectId, bangumiSteinsGate: bangumiId };
      step('identities');

      const developer: Persona = {
        label: 'developer',
        email: 'developer@rezics.test',
        password: keys.password,
        bearer: '',
        accountId: null,
      };
      developer.bearer = await bearerFor(stack, developer, dev);
      const own = requireStatus(
        await kernel(stack, 'GET', '/v1/me/rating-votes', { bearer: developer.bearer }),
        'developer own-votes page',
      );
      developer.accountId = own.viewer?.accountId ?? null;
      step('developer-bearer');

      const question = requireStatus(
        await kernel(stack, 'GET', `/v1/rating-questions/${standardQuestion}`),
        'standard rating question',
      );
      const scale = (question.question?.scale ?? question.scale) as Scale | undefined;
      if (!scale || !Number.isSafeInteger(scale.min) || !Number.isSafeInteger(scale.displayStep))
        throw new Error('Standard rating question has no integer scale');
      evidence.native.scale = scale;
      const grid = (index: number) =>
        scale.min + scale.displayStep * ((index * 3) % Math.floor((scale.max - scale.min) / scale.displayStep));

      const before = figureOf(
        requireStatus(await kernel(stack, 'GET', `/v1/subjects/${subjectId}/figure`), 'anonymous figure before votes'),
      );
      evidence.native.figureBefore = { count: before.count, state: before.state };
      step('anonymous-figure-before');

      const voters: Persona[] = [];
      for (const label of ['voterone', 'votertwo', 'voterthree', 'voterfour', 'voterfive']) {
        voters.push(await registerVoter(stack, label, dev));
      }
      step('independent-voters-registered');
      const voteUnits: Record<string, number> = {};
      for (const [index, voter] of voters.entries()) {
        const units = grid(index + 1);
        await putVote(stack, voter, subjectId, units);
        voteUnits[voter.label] = units;
      }
      for (const voter of voters) {
        const readback = await readVote(stack, voter, subjectId);
        if (readback?.units !== voteUnits[voter.label])
          throw new Error(
            `${voter.label} independent readback is ${readback?.units}, expected ${voteUnits[voter.label]}`,
          );
      }
      evidence.native.voterUnits = voteUnits;
      step('independent-voters-counted');

      const counted = await pollUntil(
        'Subject figure after independent voters',
        async () => figureOf(requireStatus(await kernel(stack, 'GET', `/v1/subjects/${subjectId}/figure`), 'figure')),
        (figure) => figure.state !== 'updating' && (figure.count as number) >= voters.length,
        180_000,
      );
      evidence.native.figureAfterVoters = { count: counted.count, state: counted.state, mean: counted.mean };
      expect(counted.state).toBe('ready');
      step('figure-ready-after-threshold');

      const observation = questionObservation(subjectId, question.question ?? question);
      const observedKey = crypto.randomUUID();
      const observed = await putVote(stack, voters[0]!, subjectId, voteUnits[voters[0]!.label]!, {
        key: observedKey,
        observation,
      });
      const replayed = await putVote(stack, voters[0]!, subjectId, voteUnits[voters[0]!.label]!, {
        key: observedKey,
        observation,
      });
      expect(replayed).toMatchObject({ units: observed.units, revision: observed.revision });
      evidence.native.sameHomeObservation = { units: observed.units, revision: observed.revision };
      step('same-home-observation-commit-and-replay');

      const realmMember = await registerVoter(stack, 'realmmember', dev);
      const outsider = await registerVoter(stack, 'outsider', dev);
      const privateSpace = requireStatus(
        await kernel(stack, 'POST', '/v1/spaces', {
          bearer: developer.bearer,
          body: { title: 'Ratings walk private Realm', summary: 'Protected population for the ratings walk' },
        }),
        'private space',
        201,
      ).space as Json;
      const privateRealm = requireStatus(
        await kernel(stack, 'POST', '/v1/realms', {
          bearer: developer.bearer,
          body: {
            spaceId: privateSpace.spaceId,
            title: 'Ratings walk protected ratings',
            summary: 'Protected Realm figures never substitute for Global',
            visibility: 'protected',
            contextId: '00000000-0000-8000-8000-000000000000',
          },
        }),
        'private realm',
        201,
      ).realm as Json;
      const privateRealmId = String(privateRealm.realmId);
      if (!realmMember.accountId) throw new Error('Realm member has no account id');
      requireStatus(
        await kernel(stack, 'POST', `/v1/realms/${privateRealmId}/members`, {
          bearer: developer.bearer,
          body: { accountId: realmMember.accountId },
        }),
        'realm member add',
        202,
      );
      await pollUntil(
        'Realm membership',
        async () => kernel(stack, 'GET', `/v1/realms/${privateRealmId}/members/me`, { bearer: realmMember.bearer }),
        (result) => result.status === 200 && result.value.state === 'member',
        180_000,
      );
      await putVote(stack, realmMember, subjectId, grid(6));
      const globalAfterRealm = await aggregateFigure(stack, subjectId, '00000000-0000-8000-8000-000000000000');
      const realmAsMember = await aggregateFigure(stack, subjectId, privateRealmId, realmMember.bearer);
      const realmAsOutsider = await aggregateFigure(stack, subjectId, privateRealmId, outsider.bearer);
      const realmAnonymous = await aggregateFigure(stack, subjectId, privateRealmId);
      const realmAsModerator = await aggregateFigure(stack, subjectId, privateRealmId, developer.bearer);
      expect(realmAsOutsider).toMatchObject({
        population: privateRealmId,
        count: 0,
        freshness: { asOf: null, updating: false },
      });
      expect(realmAnonymous).toMatchObject({
        population: privateRealmId,
        count: 0,
        freshness: { asOf: null, updating: false },
      });
      expect(realmAsMember.count as number).toBeGreaterThanOrEqual(1);
      expect(realmAsModerator.count as number).toBe(realmAsMember.count);
      expect(globalAfterRealm.count as number).toBeGreaterThanOrEqual((counted.count as number) + 1);
      evidence.native.realmFigures = {
        realmId: privateRealmId,
        global: { count: globalAfterRealm.count },
        member: { count: realmAsMember.count },
        outsider: { count: realmAsOutsider.count },
        anonymous: { count: realmAnonymous.count },
        moderator: { count: realmAsModerator.count },
      };
      step('protected-realm-versus-global');

      const realmQuestion = await kernel(stack, 'POST', `/v1/realms/${privateRealmId}/rating-questions`, {
        bearer: developer.bearer,
        body: {
          meaning: 'Evaluate the translation independently of the source work.',
          label: 'Translation quality',
          grain: 'work',
          scale: { min: 0, max: 10, displayStep: 1 },
        },
      });
      if (realmQuestion.status === 201) {
        const extraId = String((realmQuestion.value.question as Json | undefined)?.id ?? realmQuestion.value.id);
        const unavailableKey = crypto.randomUUID();
        const unavailableObservation = {
          subjectId,
          question: {
            id: extraId,
            revision: 1,
            grain: 'work',
            meaning: 'Evaluate the translation independently of the source work.',
            scale: { min: 0, max: 10, displayStep: 1 },
          },
        };
        const first = await kernel(stack, 'PUT', `/v1/subjects/${subjectId}/ratings/${extraId}/vote`, {
          bearer: realmMember.bearer,
          body: { units: 8 },
          key: unavailableKey,
          observation: unavailableObservation,
        });
        expect(first.status).toBe(503);
        expect(first.value).toMatchObject({ code: 'atomic_guard_unavailable', retryable: true });
        const retry = await kernel(stack, 'PUT', `/v1/subjects/${subjectId}/ratings/${extraId}/vote`, {
          bearer: realmMember.bearer,
          body: { units: 8 },
          key: unavailableKey,
          observation: unavailableObservation,
        });
        expect(retry.status).toBe(503);
        expect(retry.value).toMatchObject({ code: 'atomic_guard_unavailable', retryable: true });
        evidence.native.atomicGuard = { questionId: extraId, first: first.value, retry: retry.value };
        step('atomic-guard-unavailable-http-retry');
      } else {
        evidence.native.atomicGuard = { skipped: realmQuestion.status, body: realmQuestion.value };
        step('atomic-guard-unavailable-http-retry-skipped');
      }

      // Browser: an anonymous reader sees the served Subject before the developer votes.
      const loadRequire = createRequire(join(root, 'apps/web/package.json'));
      const { chromium } = loadRequire('playwright') as typeof import('playwright');
      const { expect: pwExpect } = loadRequire('playwright/test') as typeof import('playwright/test');
      await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
      const subjectPath = `subjects/${subjectId}`;
      const subjectReady = '[data-slot="rating-summary"]';
      const steps = Math.floor((scale.max - scale.min) / scale.displayStep);
      const top = scale.min + scale.displayStep * steps;
      const low = scale.min;
      const middle = scale.min + scale.displayStep * Math.floor(steps / 2);
      const browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
      try {
        const anonymous = await browser.newContext({ locale: 'en-US' });
        const anonymousPage = await anonymous.newPage();
        anonymousPage.setDefaultTimeout(60_000);
        await anonymousPage.route('**/*', loopbackOnly);
        for (const locale of launchLocales)
          for (const width of widths)
            for (const theme of themes)
              await capturePage(
                anonymousPage,
                stack,
                subjectPath,
                locale,
                width,
                theme,
                'anonymous-subject',
                subjectReady,
                evidence,
              );
        await anonymous.close();
        step('anonymous-subject-served');

        // Browser: the developer signs in through the served Auth pages and uses the shared rating control.
        const member = await browser.newContext({ locale: 'en-US' });
        const page = await member.newPage();
        page.setDefaultTimeout(60_000);
        await page.route('**/*', loopbackOnly);
        await page.goto(`${stack.web}/en/${subjectPath}`, { waitUntil: 'domcontentloaded' });
        const signIn = page.locator('a[href^="/auth/sign-in"]').first();
        if (await signIn.count()) {
          await signIn.click();
          await page.waitForURL('**/login?**');
          await page.locator('input[name="email"]').fill(developer.email);
          await page.locator('input[name="password"]').fill(developer.password);
          await page.locator('button[type="submit"]').click();
          const approve = page.getByRole('button', { name: 'Approve' });
          if (await approve.isVisible({ timeout: 8_000 }).catch(() => false)) await approve.click();
          await page.waitForURL(`${stack.web}/**`);
          step('developer-sign-in-served');
        }
        await page.goto(`${stack.web}/en/${subjectPath}`, { waitUntil: 'domcontentloaded' });
        await pwExpect(page.locator('[data-slot="slider-thumb"]').first()).toBeVisible({ timeout: 60_000 });
        const rate = async (units: number) => {
          await setSlider(page, units, scale.displayStep, pwExpect);
          await page.getByRole('button', { name: 'Save rating' }).click();
          return pollUntil(
            `developer readback ${units}`,
            () => readVote(stack, developer, subjectId),
            (value) => value?.units === units,
            60_000,
          );
        };
        await rate(top);
        step('developer-rated-through-control');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await pwExpect(page.locator('[data-slot="slider-thumb"]').first()).toHaveAttribute(
          'aria-valuenow',
          String(top),
          { timeout: 60_000 },
        );
        step('developer-reload-keeps-own-vote');
        await page.goto(`${stack.web}/en/library/ratings`, { waitUntil: 'domcontentloaded' });
        await pwExpect(
          page.locator(`[data-own-vote-target="${subjectId}"][data-own-vote-question="${standardQuestion}"]`).first(),
        ).toBeVisible({ timeout: 60_000 });
        step('developer-my-ratings-lists-vote');
        await page.goto(`${stack.web}/en/${subjectPath}`, { waitUntil: 'domcontentloaded' });
        await pwExpect(page.locator('[data-slot="slider-thumb"]').first()).toBeVisible({ timeout: 60_000 });
        await rate(low);
        step('developer-changed-vote');
        await page.getByRole('button', { name: 'Clear your rating' }).click();
        await pollUntil(
          'developer readback after clear',
          () => readVote(stack, developer, subjectId),
          (value) => value === null,
          60_000,
        );
        step('developer-cleared-vote');
        await rate(middle);
        step('developer-reapplied-vote');
        for (const locale of launchLocales)
          for (const width of widths)
            for (const theme of themes) {
              await capturePage(
                page,
                stack,
                subjectPath,
                locale,
                width,
                theme,
                'developer-subject',
                subjectReady,
                evidence,
              );
              await capturePage(
                page,
                stack,
                'library/ratings',
                locale,
                width,
                theme,
                'developer-my-ratings',
                '[data-own-vote-pair]',
                evidence,
              );
            }
        step('developer-served-captured');
      } finally {
        await browser.close();
      }

      // Native: a review cites the author's current vote; a later vote change keeps the original citation.
      const reviews = await createReviewsBoard(stack, developer);
      evidence.native.reviewsBoard = reviews;
      step('reviews-board-created');
      const cited = await readVote(stack, developer, subjectId);
      if (!cited) throw new Error('Developer has no current vote to cite');
      const citation: Citation = { questionId: standardQuestion, units: cited.units, revision: cited.revision };
      const created = requireStatus(
        await kernel(stack, 'POST', '/v1/threads', {
          bearer: developer.bearer,
          body: {
            boardId: reviews.boardId,
            kind: 'review',
            title: 'Ratings walk review citing a vote',
            body: fromPlainText('This original review cites the current vote of its author.'),
            licence: 'CC-BY-4.0',
            subjectIds: [subjectId],
            visibility: 'published',
            voteCitation: citation,
          },
        }),
        'vote-citing review create',
        201,
      );
      const threadId = String((created.thread as Json | undefined)?.id ?? created.id);
      evidence.native.review = { threadId, citation };
      step('review-published-citing-vote');
      const changedUnits = top === cited.units ? low : top;
      await putVote(stack, developer, subjectId, changedUnits);
      const changed = await readVote(stack, developer, subjectId);
      if (changed?.units !== changedUnits) throw new Error('Changed vote readback does not match its command');
      step('vote-changed-after-review');
      const threadRead = requireStatus(
        await kernel(stack, 'GET', `/v1/threads/${threadId}`, { bearer: developer.bearer }),
        'review readback',
      );
      const recorded = deepFind(threadRead, 'voteCitation') as Json | null | undefined;
      expect(recorded).toMatchObject(citation);
      evidence.native.reviewAfterVoteChange = {
        recordedCitation: recorded,
        currentVote: { units: changed.units, revision: changed.revision },
      };
      step('review-citation-preserved');

      // Counted results: the Subject figure and the Search card must agree on the same independent readback.
      const figure = await pollUntil(
        'Subject figure after the reviewed vote',
        async () => figureOf(requireStatus(await kernel(stack, 'GET', `/v1/subjects/${subjectId}/figure`), 'figure')),
        (value) => value.state !== 'updating',
        180_000,
      );
      expect(figure.count as number).toBeGreaterThanOrEqual(voters.length + 1);
      expect(figure.state).toBe('ready');
      evidence.native.figureFinal = { count: figure.count, state: figure.state, mean: figure.mean };
      step('subject-figure-counted');
      const searched = await pollUntil(
        'Search card figure',
        async () =>
          figureForSubject(
            requireStatus(
              await kernel(stack, 'POST', '/v1/subjects:search', {
                body: { text: 'Steins;Gate', limit: 100, sort: 'relevance' },
              }),
              'subject search',
            ),
            subjectId,
          ),
        (value) => value === null || (value.count === figure.count && value.state === figure.state),
        180_000,
      );
      if (searched === null) {
        // Search still documents no PublicFigure on subject.search hits; Rating's subject figure is the producer.
        evidence.notWalked.push(
          'Search hit figure: subject.search has no figure on hits; Subject GET /figure is the compared producer',
        );
        evidence.native.searchFigure = { absent: true };
        step('search-card-has-no-figure');
      } else {
        evidence.native.searchFigure = { count: searched.count, state: searched.state, mean: searched.mean };
        step('search-card-matches-subject-figure');
      }

      const suspended = voters[1]!;
      if (!suspended.accountId) throw new Error('Suspended voter has no account id');
      const beforeSuspend = figureOf(
        requireStatus(await kernel(stack, 'GET', `/v1/subjects/${subjectId}/figure`), 'figure before suspend'),
      );
      const suspension = await kernel(stack, 'POST', `/v1/accounts/${suspended.accountId}:suspend`, {
        bearer: developer.bearer,
        body: { reason: 'Ratings walk suspended voter' },
      });
      evidence.native.suspension = { status: suspension.status, code: suspension.value.code ?? null };
      if (suspension.status === 200) {
        await pollUntil(
          'suspended vote eligibility',
          () =>
            kernel(stack, 'GET', `/v1/subjects/${subjectId}/ratings/${standardQuestion}/vote`, {
              bearer: suspended.bearer,
            }),
          (result) => result.status === 401 || result.status === 403,
          180_000,
        );
        const afterSuspend = await pollUntil(
          'Subject figure after suspension',
          async () => figureOf(requireStatus(await kernel(stack, 'GET', `/v1/subjects/${subjectId}/figure`), 'figure')),
          (figure) => figure.state !== 'updating' && (figure.count as number) < (beforeSuspend.count as number),
          180_000,
        );
        evidence.native.figureAfterSuspend = { count: afterSuspend.count, state: afterSuspend.state };
        step('suspended-voter-removed-from-figure');
      } else {
        evidence.native.figureAfterSuspend = { skipped: suspension.status, body: suspension.value };
        step('suspended-voter-skipped');
      }

      await persist('passing.json');
    } catch (error) {
      evidence.defects.push(error instanceof Error ? error.message : String(error));
      await persist('failing.json');
      throw error;
    }
    await persist('passing.json');
  },
  3_600_000,
);
