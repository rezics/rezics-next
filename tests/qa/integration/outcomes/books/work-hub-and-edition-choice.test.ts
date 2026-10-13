import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import hub from '../../../../../scripts/qa/cases/outcomes/books/work-hub-and-edition-choice.ts';
import ambiguous from '../../../../../scripts/qa/cases/outcomes/books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions.ts';
import formats from '../../../../../scripts/qa/cases/outcomes/books/choose-among-mixed-formats-mixed-formats.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Release = {
  id: string; revision: string; platform: string; title: { value: string };
  coverage?: { work: string }[];
};
type Preference = {
  work: string;
  language: string;
  version: number;
  edition: { kind: string; resource: string; revision: string };
};
type Page<T> = { items: T[]; nextCursor: string | null };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let book: Work;
let emptyBook: Work;
const recordings = {
  hub: new OutcomeRecorder(hub),
  ambiguous: new OutcomeRecorder(ambiguous),
  formats: new OutcomeRecorder(formats),
};
const releases: Release[] = [];
const title = `Bookgarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: () => Promise<Response>, status = 200): Promise<T> {
  const response = await outcomeResponse(request);
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function privateAnswer<T>(request: () => Promise<Response>): Promise<T> {
  const response = await outcomeResponse(request);
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return JSON.parse(raw) as T;
}

// Setup exceptions stay in beforeAll: a failed fixture is never an expected product failure.
async function publishBook(recording: OutcomeRecorder) {
  releases.length = 0;
  sessions = await personaSessions('public');
  await recording.prepare();
  const owner = sessions.owner;
  const actor = owner.actingSubject;
  emptyBook = await answer<Work>(
    () => owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${title} without editions`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
    }),
    201,
  );
  // A catalogue empty state still needs a publicly selected publication; draft metadata is owner-only.
  const emptyDraft = await answer<{ contribution: string; draftRevision: string }>(
    () => owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: emptyBook.work, language: 'en',
      body: 'An original fixture story without editions: a gardener prepares an empty plot.',
      actingSubject: actor,
    }),
    201,
  );
  const emptyPublication = await answer<{ publicationDecision: string }>(
    () => owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: emptyDraft.contribution,
      expectedDraftHead: emptyDraft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }),
    201,
  );
  await answer(
    () => owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', work: emptyBook.work, contribution: emptyDraft.contribution,
      publicationDecision: emptyPublication.publicationDecision, expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: emptyBook.mainVersion },
      selectionBasis: 'main-maintainer', actingSubject: actor,
    }),
    201,
  );
  book = await answer<Work>(
    () => owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
    }),
    201,
  );
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    () => owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: book.work, language: 'en',
      body: 'An original fixture story: a gardener plants a seed and watches it grow.',
      actingSubject: actor,
    }),
    201,
  );
  const publication = await answer<{ publicationDecision: string }>(
    () => owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }),
    201,
  );
  await answer(
    () => owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', work: book.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: book.mainVersion },
      selectionBasis: 'main-maintainer', actingSubject: actor,
    }),
    201,
  );
  const workPath = `/v1/works/${short(book.work)}`;
  const header = await answer<{ mainVersionRevision: string }>(
    () => owner.main('GET', `${workPath}?${acting(owner)}`),
  );
  const realization = `https://rezics.com/id/${randomUUID()}`;
  const original = await answer<{ revision: string }>(
    () => owner.main('PUT', `${workPath}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: {
        kind: 'main-version', work: book.work, mainVersion: book.mainVersion,
        revision: header.mainVersionRevision,
      },
      status: 'official', verification: 'verified', evidence: book.work,
    }),
  );
  for (const platform of ['paperback', 'ebook', 'audiobook']) {
    const id = `https://rezics.com/id/${randomUUID()}`;
    const result = await answer<{ revision: string }>(
      () => owner.main('PUT', `${workPath}/releases/${short(id)}`, {
        profile: 'release-v2', id, expectedHead: null, actingSubject: actor,
        kind: 'formal', status: 'official', identifiers: [], territory: null,
        titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
        editionStatement: platform, publisher: 'Original fixture owner', publicationYear: 2026,
        isbn13: null, originalUrl: null, fixedRelease: null, evidence: null, platform,
        coverage: [{ realization, revision: original.revision, completeness: 'complete' }],
      }),
    );
    releases.push({ id, revision: result.revision, platform, title: { value: title } });
  }
}

// Operator calls use ordinary reader/public routes, with separate own-Person control.
async function editions(name: PersonaName, mode: 'hub' | 'ambiguous' | 'formats') {
  const person = sessions[name];
  const recording = recordings[mode];
  const sample = recording.session(name, person);
  const workPath = `/v1/works/${short(book.work)}`;
  const header = await answer<{ id: string }>(
    () => sample('work-header', 'GET', `${workPath}?${acting(person)}`),
  );
  expect(header.id).toBe(book.work);
  const credits = await answer<{ items: { agent: string | null; role: string }[] }>(
    () => sample('work-credits', 'GET', `${workPath}/credits?${acting(person)}`),
  );
  expect(credits.items.some(credit =>
    credit.agent === sessions.owner.actingSubject && credit.role === 'author')).toBe(true);
  const page = await answer<Page<Release>>(
    () => sample('release-choices', 'GET', `${workPath}/releases?${acting(person)}&limit=${mode === 'hub' ? 2 : 20}`),
  );
  const choices = [...page.items];
  if (mode === 'hub') {
    expect(page.nextCursor).not.toBeNull();
    const next = await answer<Page<Release>>(
      () => sample('release-choices-next', 'GET', `${workPath}/releases?${acting(person)}&limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`),
    );
    choices.push(...next.items);
    expect(next.nextCursor).toBeNull();
  } else {
    expect(page.nextCursor).toBeNull();
  }
  expect(choices.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  expect(new Set(choices.map(item => item.title.value)).size).toBe(1);
  expect(choices.map(item => item.platform).sort()).toEqual(['audiobook', 'ebook', 'paperback']);
  for (const choice of choices) {
    expect(choice).toMatchObject(releases.find(release => release.id === choice.id)!);
    if (mode === 'hub') {
      const detail = await answer<Release>(
        () => sample(`release-detail-${choice.platform}`, 'GET', `${workPath}/releases/${short(choice.id)}?${acting(person)}`),
      );
      expect(detail).toMatchObject(choice);
    }
  }

  // One signed-in reader supplies the extra reads made by the hub and editions routes.
  if (name === 'member') await supportingReads(mode, sample, choices);

  const path = `/v1/me/edition-preferences/${short(book.work)}`;
  const body = {
    actingSubject: person.actingSubject ?? sessions.member.actingSubject,
    expectedVersion: 0, language: 'en',
    edition: { kind: 'release', resource: releases[0]!.id, revision: releases[0]!.revision },
  };
  if (name === 'visitor') {
    await answer(() => sample('preference-sign-in', 'GET', `${path}?actingSubject=${encodeURIComponent(body.actingSubject!)}`), 401);
    await answer(() => sample('save-preference-sign-in', 'PUT', path, body), 401);
    if (mode === 'hub') {
      await answer(() => sample('progress-sign-in', 'GET', `/v1/me/progress-summaries/${short(book.work)}?actingSubject=${encodeURIComponent(body.actingSubject!)}`), 401);
    }
    return;
  }
  const foreign = name === 'member' ? sessions.stranger : sessions.member;
  const foreignSample = recording.session(name, foreign);
  const foreignPath = `${path}?${acting(foreign)}`;
  const before = await privateAnswer<Preference | null>(() => foreignSample('foreign-preference-before', 'GET', foreignPath));
  const ownPath = `${path}?${acting(person)}`;
  let current = await privateAnswer<Preference | null>(() => sample('own-preference-before', 'GET', ownPath));
  for (const release of mode === 'hub' ? choices.slice(0, 1) : choices) {
    const key = randomUUID();
    const command = {
      ...body, expectedVersion: current?.version ?? 0,
      edition: { kind: 'release', resource: release.id, revision: release.revision },
    };
    const saved = await privateAnswer<Preference & { replayed: boolean }>(
      () => sample(`save-preference-${release.platform}`, 'PUT', path, command, key),
    );
    expect(saved).toMatchObject({
      work: book.work, language: 'en', edition: command.edition,
      version: command.expectedVersion + 1, replayed: false,
    });
    current = await privateAnswer<Preference>(() => sample(`own-preference-${release.platform}`, 'GET', ownPath));
    expect(current).toEqual({
      work: saved.work, language: saved.language, edition: saved.edition, version: saved.version,
    });
    // One lost-response replay and one stale command prove these owner-store outcomes.
    if (release === choices[0]) {
      expect(await privateAnswer(() => sample('save-preference-replay', 'PUT', path, command, key))).toEqual({
        ...current, replayed: true,
      });
      const stale = await answer<{ code: string; current: Preference }>(
        () => sample('save-preference-stale', 'PUT', path, command), 409,
      );
      expect(stale.code).toBe('stale_edition_preference');
      expect(stale.current).toEqual(current);
    }
    expect(await privateAnswer(() => foreignSample(`foreign-preference-after-${release.platform}`, 'GET', foreignPath))).toEqual(before);
  }
  if (mode === 'hub') {
    const summary = await privateAnswer<{ preference: Preference }>(
      () => sample('own-progress-summary', 'GET', `/v1/me/progress-summaries/${short(book.work)}?${acting(person)}`),
    );
    expect(summary.preference).toEqual(current!);
    expect(await answer<{ code: string }>(
      () => sample('foreign-progress-denied', 'GET', `/v1/me/progress-summaries/${short(book.work)}?${acting(foreign)}`), 403,
    )).toMatchObject({ code: 'progress_denied' });
  }
  for (const denied of [
    () => sample('foreign-preference-denied', 'GET', foreignPath),
    () => sample('foreign-save-preference-denied', 'PUT', path, {
      ...body, actingSubject: foreign.actingSubject, expectedVersion: before?.version ?? 0,
    }),
  ]) {
    expect(await answer<{ code: string }>(denied, 403)).toMatchObject({ code: 'progress_denied' });
  }
  expect(await privateAnswer(() => foreignSample('foreign-preference-after-denial', 'GET', foreignPath))).toEqual(before);
  expect(await privateAnswer(() => sample('own-preference-after-denial', 'GET', ownPath))).toEqual(current);
}

async function supportingReads(mode: 'hub' | 'ambiguous' | 'formats', sample: ReturnType<OutcomeRecorder['session']>, choices: Release[]) {
  const person = sessions.member;
  const id = short(book.work);
  const workPath = `/v1/works/${id}`;
  const resourcePath = `/v1/resources/${id}`;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  const read = async <T,>(label: string, path: string, status = 200) => {
    try { return await answer<T>(() => sample(label, 'GET', viewer(path)), status); }
    catch (error) { throw new Error(`Render read ${label}: ${path}`, { cause: error }); }
  };
  const template = (label: string, query: string, parameters: Record<string, unknown> = {}) =>
    answer(() => sample(label, 'POST', '/v1/query', {
      profile: 'template-query-v1', query: `https://rezics.com/query/${query}`, revision: 1,
      parameters: { roots: [book.work], ...parameters }, presentation: { actingSubject: person.actingSubject },
    }));

  // Shared Work frame, and the edition inventory's source names. These are API answers, not story fixtures.
  const projection = await read<{ sections: { id: string; href: string }[] }>('page-projection', `${resourcePath}/page`);
  const realizations = await read<Page<{ source: { kind: string; mainVersion?: string } }>>(
    'realization-choices', `${workPath}/realizations?limit=20`);
  if (mode === 'hub') await read('availability-releases', `${workPath}/releases?limit=20`);
  if (mode !== 'hub') {
    const resources = [...new Set([
      ...realizations.items.flatMap(item => item.source.mainVersion ?? []),
      ...choices.flatMap(item => item.coverage?.map(entry => entry.work) ?? []),
    ])].sort();
    await answer(() => sample('edition-source-names', 'POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources, actingSubject: person.actingSubject,
    }));
  }
  // The hub's chooser also fetches the selected edition's own detail after a saved preference.
  if (mode !== 'hub') for (const release of releases) {
    await read(`selected-release-${release.platform}`, `${workPath}/releases/${short(release.id)}`);
  }
  const contexts = await read<{ items: { context: string }[] }>('rating-contexts', `${resourcePath}/rating-contexts?scope=global`);
  const context = contexts.items[0]?.context;
  const contextQuery = context ? `&context=${encodeURIComponent(context)}` : '';
  const sharedReads: (() => Promise<unknown>)[] = [
    () => read('session-agent', '/v1/me/session-agent'),
    () => read('person-preferences', '/v1/me/person-preferences'),
    () => read('reader-state', `${workPath}/reader-state`),
    () => read('native-agent-credits', `${workPath}/agent-credits`),
    () => template('external-credits', 'work-credits'),
    () => read('rating-summary', `${resourcePath}/ratings?scope=global${contextQuery}`),
    () => read('reader-statistics', `${workPath}/reader-stats?${contextQuery.slice(1)}`),
    () => read('continue-reading', '/v1/me/continue?limit=6'),
    // A standalone selected text has no Book composition; readStart handles this refusal by opening that text.
    () => read('contents-unavailable', `${workPath}/contents`, 404),
    () => read('progress-in-language', `/v1/me/progress-summaries/${id}?language=en`),
    // Showcase is read publicly even for signed-in viewers.
    () => answer(() => recordings[mode].session('member', sessions.visitor)('work-showcase', 'POST', '/v1/resources/showcase', {
      profile: 'work-showcase-batch-v1', targets: [book.work],
    })),
  ];
  for (const section of projection.sections.filter(section => section.id === 'statements')) {
    sharedReads.push(() => read('accepted-statements', section.href));
  }
  const emptyPath = `/v1/works/${short(emptyBook.work)}`;
  sharedReads.push(
    () => read('work-without-editions', emptyPath),
    async () => {
      const empty = await read<Page<unknown>>('realization-choices-empty', `${emptyPath}/realizations?limit=20`);
      expect(empty.items).toEqual([]);
    },
    async () => {
      const empty = await read<Page<unknown>>('release-choices-empty', `${emptyPath}/releases?limit=20`);
      expect(empty.items).toEqual([]);
    },
  );
  if (mode === 'hub') {
    sharedReads.push(
      () => read('platform-access', '/v1/me/platform-access'),
      () => read('availability-parts-unavailable', `${resourcePath}/parts?limit=1`, 404),
      () => read('parts-preview-unavailable', `${resourcePath}/parts?limit=7`, 404),
      () => read('wholes-preview-empty', `${resourcePath}/wholes?limit=3`),
      () => read('connections-preview-empty', `${resourcePath}/relations?limit=20`),
      // This fixture installs no correspondence vocabulary; the panel receives Main's missing-definition refusal.
      () => read('correspondence-definition-unavailable', '/v1/lexicon/definitions/correspondence-equivalent', 404),
      () => read('rating-populations', `/v1/rating-populations?target=${encodeURIComponent(book.work)}&limit=20`),
      () => template('realm-adoptions-empty', 'work-adoptions'),
      () => read('more-by-author', `/v1/agents/${short(sessions.owner.actingSubject!)}/works?limit=12`),
      () => read('also-enjoyed', `${workPath}/also-enjoyed?limit=12`),
      () => read('classifications-empty', `${workPath}/classifications?scope=global`),
      () => answer(() => recordings.hub.session('member', sessions.visitor)('classification-facets', 'GET', '/v1/facets')),
    );
    const discussion = projection.sections.find(section => section.id === 'discussion');
    if (discussion) sharedReads.push(() => read('discussion-empty', discussion.href));
    if (context) sharedReads.push(() => read('reviews-empty', `${resourcePath}/reviews?context=${encodeURIComponent(context)}&sort=helpful&limit=10`));
    if (context) sharedReads.push(() => read('review-target-relations-empty', `${resourcePath}/relations?limit=32`));
  }
  // Bound parallel reads like the catalogue example; every rejected request still fails its persona proof.
  for (let offset = 0; offset < sharedReads.length; offset += 3) {
    const results = await Promise.allSettled(sharedReads.slice(offset, offset + 3).map(read => read()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

// Each row proves one shared Book across six readers, starting with fresh credentials.
// Sharing credentials across all rows can cross Account's five-minute bearer lifetime.
describe(hub.rowId, () => {
  beforeAll(() => publishBook(recordings.hub), 180_000);
  afterAll(async () => {
    try { await recordings.hub.publish(); }
    finally { await sessions?.close(); }
  });
  outcomeTest(hub, 'visitor', () => editions('visitor', 'hub'), recordings.hub);
  outcomeTest(hub, 'stranger', () => editions('stranger', 'hub'), recordings.hub);
  outcomeTest(hub, 'member', () => editions('member', 'hub'), recordings.hub);
  outcomeTest(hub, 'owner', () => editions('owner', 'hub'), recordings.hub);
  outcomeTest(hub, 'moderator', () => editions('moderator', 'hub'), recordings.hub);
  outcomeTest(hub, 'operator', () => editions('operator', 'hub'), recordings.hub);
});
describe(ambiguous.rowId, () => {
  beforeAll(() => publishBook(recordings.ambiguous), 180_000);
  afterAll(async () => {
    try { await recordings.ambiguous.publish(); }
    finally { await sessions?.close(); }
  });
  outcomeTest(ambiguous, 'visitor', () => editions('visitor', 'ambiguous'), recordings.ambiguous);
  outcomeTest(ambiguous, 'stranger', () => editions('stranger', 'ambiguous'), recordings.ambiguous);
  outcomeTest(ambiguous, 'member', () => editions('member', 'ambiguous'), recordings.ambiguous);
  outcomeTest(ambiguous, 'owner', () => editions('owner', 'ambiguous'), recordings.ambiguous);
  outcomeTest(ambiguous, 'moderator', () => editions('moderator', 'ambiguous'), recordings.ambiguous);
  outcomeTest(ambiguous, 'operator', () => editions('operator', 'ambiguous'), recordings.ambiguous);
});
describe(formats.rowId, () => {
  beforeAll(() => publishBook(recordings.formats), 180_000);
  afterAll(async () => {
    try { await recordings.formats.publish(); }
    finally { await sessions?.close(); }
  });
  outcomeTest(formats, 'visitor', () => editions('visitor', 'formats'), recordings.formats);
  outcomeTest(formats, 'stranger', () => editions('stranger', 'formats'), recordings.formats);
  outcomeTest(formats, 'member', () => editions('member', 'formats'), recordings.formats);
  outcomeTest(formats, 'owner', () => editions('owner', 'formats'), recordings.formats);
  outcomeTest(formats, 'moderator', () => editions('moderator', 'formats'), recordings.formats);
  outcomeTest(formats, 'operator', () => editions('operator', 'formats'), recordings.formats);
});
