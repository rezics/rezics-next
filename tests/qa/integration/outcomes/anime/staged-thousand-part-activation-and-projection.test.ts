import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  authorize,
  exchangeCode,
  LocalOAuthSession,
  type LocalOAuthClient,
} from '../../../../../scripts/lib/oauth-client.ts';
import {
  personaNames,
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Stage = {
  id: string;
  revision: string;
  holder: string;
  fence: string;
  status: string;
  records: number;
  pages: number;
  placementCount: number | null;
};
type Pending = {
  operationId: string;
  status: string;
  retry?: { allowed: boolean; afterMs: number };
};
type Page = {
  items: { occurrence: string; work?: string; labels: { value: string; language: string }[] }[];
  nextCursor: string | null;
  complete: boolean;
  count: { value: number; kind: string; total: null };
  search?: { status: string };
};
type Observation = { status: number | null; raw: string; elapsedMs: number; error?: string };
const activationBudgetMs = 60_000;
const projectionBudgetMs = 12_000;
const evidenceDirectory = resolve(
  '.temp/goal/evidence',
  `staged-thousand-${Bun.env.REZICS_QA_RUN_ID}`,
);
const transcript = resolve(evidenceDirectory, 'http.jsonl');
const matrix: Record<string, { status: string; elapsedMs: number; reason?: string }> = {};
let sessions: PersonaSessions;
let sourceRevision = '';
let published: Work;
let privateWork: Work;
let laterWork: Work;
let composition: Composition;
let laterComposition: Composition;
let stage: Stage | undefined;
let terminal: Stage | undefined;
let prerequisite: string | undefined;
let preparationError: string | undefined;
let activationError: string | undefined;
let laterError: string | undefined;
let laterResult: Composition | undefined;
let activationElapsedMs = 0;
let laterElapsedMs = 0;
let preparationElapsedMs = 0;
let stagingElapsedMs = 0;
let requestDeadline: number | undefined;
const occurrences: string[] = [];
const episodes: Work[] = [];
const laterLabel = `Continued original episode ${randomUUID()}`;
const short = (id: string) => id.slice(-36);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const query = (person: PersonaSession, fields: Record<string, string> = {}) =>
  new URLSearchParams({
    position: 'start',
    language: 'en',
    ...fields,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
const pause = (ms: number) => new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));
setDefaultTimeout(90_000);

function record(value: object) {
  appendFileSync(transcript, `${JSON.stringify(value)}\n`);
}
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  if (response.status !== status)
    throw new Error(`HTTP ${response.status}, expected ${status}: ${raw}`);
  return JSON.parse(raw) as T;
}

// Reauthorize through each person's live Account session before preparation.
// Main requests remain real HTTP; the journal omits bearer/cookie credentials.
async function recordedSession(name: PersonaName, person: PersonaSession): Promise<PersonaSession> {
  let oauth: LocalOAuthSession | undefined;
  if (person.accountId) {
    const stack = resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
    const directory = readdirSync(stack).find((entry) => entry.startsWith('g-1005-auth-'));
    if (!directory) throw new Error('Public Persona OAuth configuration is unavailable');
    const config = JSON.parse(readFileSync(resolve(stack, directory, 'public.json'), 'utf8')) as {
      clientId: string;
      redirectUris: string[];
      scope: string;
    };
    const client: LocalOAuthClient = {
      account: Bun.env.ACCOUNT_BASE_URL!,
      clientId: config.clientId,
      redirectUri: config.redirectUris[0]!,
      scope: config.scope,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
      fetch: async (input, init) => {
        const url = new URL(input);
        if (url.pathname === '/api/auth/oauth2/authorize')
          return person.account('GET', `${url.pathname}${url.search}`);
        if (url.pathname === '/api/account/consent')
          return person.account(
            'POST',
            `${url.pathname}${url.search}`,
            JSON.parse(String(init?.body)),
          );
        return fetch(input, init);
      },
    };
    const authorized = await authorize(client, '');
    if (!authorized.ok)
      throw new Error(`Public OAuth authorization HTTP ${authorized.response.status}`);
    const grant = await exchangeCode(client, authorized);
    oauth = new LocalOAuthSession(client, grant, Date.now() + (grant.expires_in ?? 300) * 1000);
  }
  const sessionKey = randomUUID();
  return {
    ...person,
    main: async (method, path, body, key) => {
      const idempotencyKey = key ?? (!['GET', 'HEAD'].includes(method) ? randomUUID() : undefined);
      const headers = new Headers();
      if (oauth) {
        headers.set('authorization', `Bearer ${await oauth.current(Date.now(), 60_000)}`);
        headers.set('x-session-key', sessionKey);
      }
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
      const request = {
        persona: name,
        method,
        path,
        body,
        idempotencyKey,
        actingSubject: person.actingSubject,
        bearer: Boolean(oauth),
        sessionKey,
      };
      const started = performance.now();
      try {
        const response = await fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(
            requestDeadline === undefined
              ? 20_000
              : Math.max(1, Math.ceil(requestDeadline - performance.now())),
          ),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const raw = await response.text();
        record({
          request,
          response: { status: response.status, headers: Object.fromEntries(response.headers), raw },
          at: new Date().toISOString(),
          elapsedMs: performance.now() - started,
        });
        return new Response(raw, { status: response.status, headers: response.headers });
      } catch (error) {
        record({
          request,
          response: null,
          error: reason(error),
          elapsedMs: performance.now() - started,
        });
        throw error;
      }
    },
  };
}

async function observed(pending: Promise<Response>): Promise<Observation> {
  const started = performance.now();
  try {
    const response = await pending;
    return {
      status: response.status,
      raw: await response.text(),
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    return { status: null, raw: '', error: reason(error), elapsedMs: performance.now() - started };
  }
}

// Only a public 202 permits command recovery. Preserve body and key, honor its
// retry interval, and retain every advertised operation identity in the journal.
async function command<T>(
  person: PersonaSession,
  path: string,
  body: object,
  budgetMs: number,
): Promise<T> {
  const key = randomUUID();
  const deadline = performance.now() + budgetMs;
  let operationId: string | undefined;
  requestDeadline = deadline;
  try {
    for (;;) {
      const result = await observed(person.main('POST', path, body, key));
      if (result.status === 200) return JSON.parse(result.raw) as T;
      if (result.status !== 202) throw new Error(`POST ${path}: ${JSON.stringify(result)}`);
      const pending = JSON.parse(result.raw) as Pending;
      if (
        pending.status !== 'reconciling' ||
        pending.retry?.allowed !== true ||
        !Number.isFinite(pending.retry.afterMs) ||
        pending.retry.afterMs < 0 ||
        !pending.operationId
      )
        throw new Error(`POST ${path}: no advertised recovery: ${result.raw}`);
      if (operationId && operationId !== pending.operationId)
        throw new Error(`POST ${path}: recovery changed operation identity: ${result.raw}`);
      operationId = pending.operationId;
      if (performance.now() + pending.retry.afterMs >= deadline)
        throw new Error(`POST ${path}: ${budgetMs} ms deadline; last response ${result.raw}`);
      await pause(pending.retry.afterMs);
    }
  } finally {
    requestDeadline = undefined;
  }
}

async function create(title: string, type: string, publish = true): Promise<Work> {
  const owner = sessions.owner;
  const work = await answer<Work>(
    owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1',
      title,
      language: 'en',
      semanticTypes: [type],
      authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  if (publish) {
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `Original synthetic ${title}: a gardener sails between seed islands and records each journey.`,
        actingSubject: owner.actingSubject,
      }),
      201,
    );
    const publication = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: owner.actingSubject,
      }),
      201,
    );
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work,
        contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer',
        actingSubject: owner.actingSubject,
      }),
      201,
    );
  }
  return work;
}

async function fixture() {
  sessions = await personaSessions();
  for (const name of personaNames) sessions[name] = await recordedSession(name, sessions[name]);
  const owner = sessions.owner,
    operator = sessions.operator;
  const authority = await answer<{ authorityEpoch: string }>(
    operator.main(
      'GET',
      `/v1/access/grants?issuerSubject=${encodeURIComponent(operator.actingSubject!)}`,
    ),
  );
  await answer(
    operator.main('POST', '/v1/access/grant-changes', {
      profile: 'work-create-agent-grant-change-v1',
      action: 'create',
      grantId: randomUUID(),
      issuerSubject: operator.actingSubject,
      expectedAuthorityEpoch: authority.authorityEpoch,
      recipientSubject: owner.actingSubject,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  const tag = randomUUID();
  published = await create(`Staged thousand seed islands ${tag}`, 'https://schema.org/TVSeries');
  privateWork = await create(`Private seed islands ${tag}`, 'https://schema.org/TVSeries', false);
  laterWork = await create(`Later public seed islands ${tag}`, 'https://schema.org/TVSeries');
  for (let index = 0; index < 4; index++)
    episodes.push(
      await create(`Original seed episode ${index + 1} ${tag}`, 'https://schema.org/VideoObject'),
    );
  const compose = (work: Work) =>
    answer<Composition>(
      owner.main('POST', '/v1/compositions', {
        profile: 'work-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: owner.actingSubject,
      }),
      201,
    );
  composition = await compose(published);
  laterComposition = await compose(laterWork);
}

async function stageInventory() {
  const operator = sessions.operator;
  const grants = await answer<{
    authorityEpoch: string;
    items: {
      permission: string;
      active: boolean;
      issuerSubject: string;
      recipient: { principalId?: string };
    }[];
  }>(
    operator.main(
      'GET',
      `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(operator.actingSubject!)}`,
    ),
  );
  const principalId = grants.items.find(
    (grant) =>
      grant.active &&
      grant.permission === 'platform:grant' &&
      grant.issuerSubject === operator.actingSubject,
  )?.recipient.principalId;
  if (!principalId)
    throw new Error('Public Access listing has no operator principal for its catalogue mandate');
  await answer(
    operator.main('POST', '/v1/access/grant-changes', {
      profile: 'platform-grant-change-v1',
      action: 'create',
      grantId: randomUUID(),
      issuerSubject: operator.actingSubject,
      expectedAuthorityEpoch: grants.authorityEpoch,
      permission: 'platform:use:catalogue-import',
      recipient: { principalId },
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  const exposure = await answer<{ groups: string[] }>(
    operator.main('GET', '/v1/me/platform-access'),
  );
  expect(exposure.groups).toContain('catalogue-import');
  const path = `/v1/compositions/${short(composition.structure)}/stages`;
  // Platform status and the catalogue mandate alone do not make a Work maintainer.
  const denied = await observed(
    operator.main('POST', path, {
      expectedHead: composition.revision,
      actingSubject: operator.actingSubject,
    }),
  );
  record({ checkpoint: 'operator-before-maintainer', ...denied });
  expect(denied.status, denied.raw).toBe(403);
  const maintainers = await answer<{ generation: string; owner: string; maintainers: string[] }>(
    sessions.owner.main('GET', `/v1/works/${short(published.work)}/maintainers`),
  );
  expect(maintainers.owner).toBe(sessions.owner.actingSubject!);
  expect(maintainers.maintainers).not.toContain(operator.actingSubject!);
  await answer(
    sessions.owner.main('POST', '/v1/work-maintainer-changes', {
      profile: 'work-maintainer-change-v1',
      work: published.work,
      actingSubject: sessions.owner.actingSubject,
      target: operator.actingSubject,
      action: 'add',
      expectedGeneration: maintainers.generation,
    }),
    201,
  );
  stage = await answer<Stage>(
    operator.main('POST', path, {
      expectedHead: composition.revision,
      actingSubject: operator.actingSubject,
    }),
    201,
  );
  for (let offset = 0, page = 0; offset < 1000; offset += 256, page++) {
    const entries = Array.from({ length: Math.min(256, 1000 - offset) }, (_, local) => {
      const index = offset + local;
      const occurrence = `https://rezics.com/id/${randomUUID()}`;
      occurrences.push(occurrence);
      const label = index === 999 ? 'Episode 1000 重逢' : `Episode ${index + 1}`;
      return {
        occurrence,
        state: 'active',
        parent: composition.structure,
        segmentKey: Math.floor(index / 32)
          .toString(36)
          .padStart(4, '0'),
        orderKey: (index % 32).toString(36).padStart(2, '0'),
        role: 'part',
        target: episodes[index % episodes.length]!.work,
        labels: [{ value: label, language: 'en' }],
        qualifier: { type: 'work-part', displayLabel: label, inclusion: 'required' },
        introducedBy: stage!.revision,
      };
    });
    await answer(
      operator.main('PUT', `${path}/${stage.id}/pages/${page}`, {
        actingSubject: operator.actingSubject,
        holder: stage.holder,
        fence: stage.fence,
        entries,
      }),
    );
  }
  stage = await answer<Stage>(
    operator.main('POST', `${path}/${stage.id}/seal`, {
      actingSubject: operator.actingSubject,
      holder: stage.holder,
      fence: stage.fence,
    }),
  );
  expect(stage).toMatchObject({ status: 'sealed', pages: 4, records: 1000 });
}

beforeAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(transcript, '');
  sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  record({
    sourceRevision,
    qaRunId: Bun.env.REZICS_QA_RUN_ID,
    activationBudgetMs,
    projectionBudgetMs,
  });
  const preparing = performance.now();
  try {
    await fixture();
  } catch (error) {
    preparationError = reason(error);
  }
  preparationElapsedMs = performance.now() - preparing;
  record({ checkpoint: 'preparation', elapsedMs: preparationElapsedMs, error: preparationError });
  if (preparationError) return;
  const stagingStarted = performance.now();
  try {
    await stageInventory();
  } catch (error) {
    prerequisite = reason(error);
  }
  stagingElapsedMs = performance.now() - stagingStarted;
  record({ checkpoint: 'staging', elapsedMs: stagingElapsedMs, error: prerequisite });
  if (!prerequisite) {
    const started = performance.now();
    try {
      terminal = await command<Stage>(
        sessions.operator,
        `/v1/compositions/${short(composition.structure)}/stages/${stage!.id}/activate`,
        { actingSubject: sessions.operator.actingSubject },
        activationBudgetMs,
      );
    } catch (error) {
      activationError = reason(error);
    }
    activationElapsedMs = performance.now() - started;
    record({
      checkpoint: 'activation',
      elapsedMs: activationElapsedMs,
      terminal,
      error: activationError,
    });
  }
  // This separate Work already exists in the same running Main stream. Even a
  // failed activation must be followed by this write before closing any process.
  const started = performance.now();
  try {
    laterResult = await command<Composition>(
      sessions.owner,
      `/v1/compositions/${short(laterComposition.structure)}/changes`,
      {
        profile: 'work-composition',
        expectedHead: laterComposition.revision,
        actingSubject: sessions.owner.actingSubject,
        operations: [
          {
            op: 'insert',
            role: 'part',
            parent: laterComposition.structure,
            position: 'last',
            target: episodes[0]!.work,
            label: { value: laterLabel, language: 'en' },
            displayLabel: laterLabel,
            inclusion: 'required',
          },
        ],
      },
      40_000,
    );
  } catch (error) {
    laterError = reason(error);
  }
  laterElapsedMs = performance.now() - started;
  record({
    checkpoint: 'later-write',
    elapsedMs: laterElapsedMs,
    result: laterResult,
    error: laterError,
  });
}, 240_000);

function qualified() {
  expect(
    preparationError,
    `PREPARATION FAILED; product assertions unqualified: ${preparationError}`,
  ).toBeUndefined();
  expect(preparationElapsedMs).toBeLessThan(600_000);
  expect(preparationElapsedMs + stagingElapsedMs).toBeLessThan(600_000);
}
async function cell(name: PersonaName | 'terminal', job: string, fn: () => Promise<void>) {
  const started = performance.now();
  try {
    qualified();
    await fn();
    matrix[`${name}/${job}`] = {
      status: prerequisite && job === 'continued-projection' ? 'unqualified' : 'passed',
      ...(prerequisite && job === 'continued-projection'
        ? { reason: 'Staging prerequisite refused; no activation preceded this read' }
        : {}),
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    matrix[`${name}/${job}`] = {
      status: preparationError || prerequisite ? 'unqualified' : 'failed',
      reason: reason(error),
      elapsedMs: performance.now() - started,
    };
    throw error;
  }
}

async function credit(person: PersonaSession, work: Work) {
  const fields = query(person);
  fields.delete('position');
  const credits = await answer<{ items: { role: string; agent: string }[] }>(
    person.main('GET', `/v1/works/${short(work.work)}/credits?${fields}`),
  );
  expect(credits.items).toContainEqual(
    expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }),
  );
  const variants = await answer<{ variants: { author: string; language: string }[] }>(
    person.main('GET', `/v1/main-versions/${short(work.mainVersion)}/native-variants`),
  );
  expect(variants.variants).toContainEqual(
    expect.objectContaining({ author: sessions.owner.actingSubject, language: 'en' }),
  );
}

async function readPage(
  person: PersonaSession,
  work: Work,
  fields: Record<string, string>,
  deadline: number,
): Promise<Page> {
  const path = `/v1/reading-positions/${short(work.work)}?${query(person, fields)}`;
  for (;;) {
    const result = await observed(person.main('GET', path));
    if (result.status === 200) return JSON.parse(result.raw) as Page;
    if (
      result.status !== 503 ||
      !result.raw.includes('work_read_unavailable') ||
      performance.now() >= deadline
    )
      throw new Error(`GET ${path}: ${JSON.stringify(result)}`);
    await pause(250);
  }
}

async function inventory(name: PersonaName) {
  expect(
    prerequisite,
    `PUBLIC PREREQUISITE REFUSED; inventory unqualified: ${prerequisite}`,
  ).toBeUndefined();
  const person = sessions[name];
  const deadline = performance.now() + 60_000;
  const firstProjectionDeadline = performance.now() + projectionBudgetMs;
  const seen: Page['items'] = [];
  let cursor: string | null = null;
  let restarts = 0;
  for (let pages = 0; pages < 1100; pages++) {
    const path = `/v1/reading-positions/${short(published.work)}?${query(person, {
      limit: '100',
      ...(cursor ? { cursor } : {}),
    })}`;
    const response = await person.main('GET', path);
    if (response.status === 409) {
      expect(await response.json()).toMatchObject({ code: 'read_basis_changed' });
      expect(++restarts).toBeLessThan(20);
      seen.length = 0;
      cursor = null;
    } else {
      const page = await answer<Page>(Promise.resolve(response));
      expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
      expect(page.complete).toBe(page.nextCursor === null);
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (page.complete && seen.length > 0) break;
    }
    expect(performance.now(), 'complete inventory traversal deadline').toBeLessThan(deadline);
    if (!cursor && seen.length === 0) {
      expect(performance.now(), 'activated inventory never became readable').toBeLessThan(
        firstProjectionDeadline,
      );
      await pause(250);
    }
  }
  expect(seen.map((item) => item.occurrence)).toEqual(occurrences);
  expect(new Set(seen.map((item) => item.occurrence)).size).toBe(1000);
  for (const [index, item] of seen.entries()) {
    expect(item.labels).toContainEqual({
      value: index === 999 ? 'Episode 1000 重逢' : `Episode ${index + 1}`,
      language: 'en',
    });
  }
  const first = await readPage(person, published, { limit: '2' }, deadline);
  expect(first.nextCursor).not.toBeNull();
  const second = await readPage(
    person,
    published,
    { limit: '2', cursor: first.nextCursor! },
    deadline,
  );
  expect(second.items.map((item) => item.occurrence)).toEqual(occurrences.slice(2, 4));
  await answer(
    person.main(
      'GET',
      `/v1/reading-positions/${short(published.work)}?${query(person, {
        limit: '2',
        q: 'Episode 8',
        cursor: first.nextCursor!,
      })}`,
    ),
    400,
  );
  const other = sessions[name === 'stranger' ? 'member' : 'stranger'];
  await answer(
    other.main(
      'GET',
      `/v1/reading-positions/${short(published.work)}?${query(other, {
        limit: '2',
        cursor: first.nextCursor!,
      })}`,
    ),
    400,
  );
  await credit(person, published);
  for (const episode of episodes) await credit(person, episode);
}

async function continuedProjection(name: PersonaName) {
  const person = sessions[name];
  const deadline = performance.now() + projectionBudgetMs;
  // Observe the projection even if the write's HTTP result was pending or lost.
  // A successful command receipt alone cannot qualify continued reading.
  let last: Page | undefined;
  do {
    last = await readPage(person, laterWork, { limit: '100' }, deadline);
    if (last.items.some((item) => item.labels.some((label) => label.value === laterLabel))) break;
    await pause(250);
  } while (performance.now() < deadline);
  expect(
    last!.items,
    `later write HTTP result: ${laterError ?? '200'}; projected page: ${JSON.stringify(last)}`,
  ).toHaveLength(1);
  expect(last!.items[0]!.occurrence).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  if (laterResult) expect(last!.items[0]!.occurrence).toBe(laterResult.occurrences[0]!);
  expect(last!.items[0]!.labels).toContainEqual({ value: laterLabel, language: 'en' });
  expect(last!.complete).toBe(true);
  await credit(person, laterWork);
}

async function fences(name: PersonaName) {
  const person = sessions[name];
  const privatePath = `/v1/reading-positions/${short(privateWork.work)}?${query(person)}`;
  if (name === 'owner') await answer(person.main('GET', privatePath));
  else
    expect(await answer(person.main('GET', privatePath), 404)).toEqual(
      await answer(
        person.main('GET', `/v1/reading-positions/${randomUUID()}?${query(person)}`),
        404,
      ),
    );
  if (['visitor', 'stranger', 'member', 'moderator'].includes(name)) {
    for (const [path, body] of [
      [
        `/v1/compositions/${short(composition.structure)}/stages`,
        {
          expectedHead: terminal?.revision ?? composition.revision,
          actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
        },
      ],
      [
        `/v1/compositions/${short(laterComposition.structure)}/changes`,
        {
          profile: 'work-composition',
          expectedHead: laterResult?.revision ?? laterComposition.revision,
          actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
          operations: [
            {
              op: 'insert',
              role: 'part',
              parent: laterComposition.structure,
              position: 'last',
              target: episodes[0]!.work,
              displayLabel: 'Unauthorized insertion',
              inclusion: 'required',
            },
          ],
        },
      ],
    ] as const) {
      const denied = await observed(person.main('POST', path, body));
      expect([401, 403, 404], `mutation denial ${path}: ${JSON.stringify(denied)}`).toContain(
        denied.status!,
      );
    }
  }
  if (name === 'operator') {
    // Its explicit maintainer grant is confined to the staged Work.
    const denied = await observed(
      person.main('POST', `/v1/compositions/${short(laterComposition.structure)}/changes`, {
        profile: 'work-composition',
        expectedHead: laterResult?.revision ?? laterComposition.revision,
        actingSubject: person.actingSubject,
        operations: [
          {
            op: 'insert',
            role: 'part',
            parent: laterComposition.structure,
            position: 'last',
            target: episodes[0]!.work,
            displayLabel: 'Unauthorized operator insertion',
            inclusion: 'required',
          },
        ],
      }),
    );
    expect(denied.status, denied.raw).toBe(403);
  }
}

test('staged thousand parts / terminal: publicly seals four pages and activates exactly 1000 placements within deadline', () =>
  cell('terminal', 'activation', async () => {
    expect(
      prerequisite,
      `PUBLIC PREREQUISITE REFUSED; activation unqualified: ${prerequisite}`,
    ).toBeUndefined();
    expect(activationError, activationError).toBeUndefined();
    expect(terminal).toMatchObject({
      status: 'activated',
      placementCount: 1000,
      records: 1000,
      pages: 4,
    });
    expect(activationElapsedMs).toBeLessThanOrEqual(activationBudgetMs);
  }));
test('staged thousand parts / terminal: submits and acknowledges a later ordinary insertion before any process restart', () =>
  cell('terminal', 'later-command', async () => {
    expect(laterError, laterError).toBeUndefined();
    expect(laterResult?.occurrences).toHaveLength(1);
  }));
for (const name of personaNames) {
  test(`staged thousand parts / ${name}: reads all exact occurrences with continuation, credit and cursor fences`, () =>
    cell(name, 'activated-inventory', () => inventory(name)));
  test(`staged thousand parts / ${name}: reads the later ordinary insertion through the same Main projection`, () =>
    cell(name, 'continued-projection', () => continuedProjection(name)));
  test(`staged thousand parts / ${name}: preserves private disclosure and refuses unrelated mutation authority`, () =>
    cell(name, 'disclosure-and-authority', () => fences(name)));
}
afterAll(async () => {
  const summary = {
    qaRunId: Bun.env.REZICS_QA_RUN_ID,
    sourceRevision,
    preparationElapsedMs,
    stagingElapsedMs,
    preparationError,
    prerequisite,
    activationElapsedMs,
    activationError,
    terminal,
    laterElapsedMs,
    laterError,
    laterResult,
    laterLabel,
    published,
    privateWork,
    laterWork,
    matrix,
    transcript,
  };
  writeFileSync(
    resolve(evidenceDirectory, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.info(
    'STAGED_THOUSAND_EVIDENCE',
    JSON.stringify({
      qaRunId: summary.qaRunId,
      preparationElapsedMs,
      stagingElapsedMs,
      prerequisite,
      activationElapsedMs,
      activationError,
      terminal,
      laterElapsedMs,
      laterError,
      laterResult,
      transcript,
      matrix: Object.fromEntries(
        Object.entries(matrix).map(([key, value]) => [
          key,
          { ...value, ...(value.reason ? { reason: value.reason.slice(0, 300) } : {}) },
        ]),
      ),
    }),
  );
  await sessions?.close();
});
