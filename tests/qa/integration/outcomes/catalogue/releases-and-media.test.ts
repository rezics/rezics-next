import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import sharp from 'sharp';
import outcomes from '../../../../../scripts/qa/cases/outcomes/catalogue/releases-and-media.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName, PersonaSession } from '../../../support/personas.ts';
import { actorQuery, allPages, assertNoHidden, digest, jsonAnswer, openReleaseMediaFixture,
  pagePath, releaseQuery, retainedBytes, shortId, workPath,
  type BusinessPage, type ImageExpectation, type PageImage, type ReleaseSelection,
  type ReleaseView, type RealizationView, type SourceCatalogue } from '../../support/catalogue-release-media.ts';

setDefaultTimeout(180_000);
let prepared: Awaited<ReturnType<typeof openReleaseMediaFixture>>;
beforeAll(async () => { prepared = await openReleaseMediaFixture(); });
afterAll(async () => { if (prepared) await prepared.sessions.close(); });

interface Preference { work: string; language: string;
  edition: { kind: 'release' | 'realization'; resource: string; revision: string } | null;
  version: number }
interface ReleaseQueryPage {
  profile: 'query-v1'; template: 'release-works-v1';
  result: { resultGrain: 'work'; items: Array<{ id: string; matchedReleases: string[]; moreMatchedReleases: boolean }>;
    nextCursor: string | null };
}

async function selectedReleases(person: PersonaSession, catalogue: SourceCatalogue, selection: ReleaseSelection) {
  const { fixture } = prepared;
  const result: ReleaseQueryPage['result']['items'] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page: ReleaseQueryPage = await jsonAnswer(person.main('POST', '/v1/query', releaseQuery([
      ...catalogue.releases.map(release => release.id), fixture.hidden.release, fixture.hidden.withdrawnRelease,
    ], selection, cursor)));
    expect(page.profile).toBe('query-v1');
    expect(page.template).toBe('release-works-v1');
    expect(page.result.resultGrain).toBe('work');
    assertNoHidden(page, fixture);
    result.push(...page.result.items);
    cursor = page.result.nextCursor ?? undefined;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      expect(cursors.size).toBeLessThan(20);
    }
  } while (cursor);
  expect(new Set(result.map(item => item.id)).size).toBe(result.length);
  return result;
}

async function nativeChoices(person: PersonaSession, catalogue: SourceCatalogue) {
  const { fixture } = prepared;
  const releases = await allPages<ReleaseView>(person, `${workPath(catalogue.work)}/releases`);
  const realizations = await allPages<RealizationView>(person, `${workPath(catalogue.work)}/realizations`);
  expect(releases.map(release => release.id).sort()).toEqual(catalogue.releases.map(release => release.id).sort());
  expect(realizations.map(item => item.id).sort()).toEqual(catalogue.realizations.map(item => item.id).sort());
  for (const expected of catalogue.releases) {
    const detail = await jsonAnswer<ReleaseView>(person.main('GET', `${workPath(catalogue.work)}/releases/${shortId(expected.id)}`));
    expect(detail).toMatchObject({ ...expected, profile: 'release-v2' });
    expect(detail.identifiers).toEqual(expected.identifiers);
    expect(detail.coverage).toEqual(expected.coverage);
    expect(detail.sourceEvidence).toEqual(expected.sourceEvidence);
    // Unknown publication facts remain null, including where other editions have dates.
    expect(detail.publicationYear).toBe(expected.publicationYear);
    expect(detail.territory).toBe(expected.territory);
    expect(releases.find(release => release.id === expected.id)).toMatchObject(expected);
    for (const entry of detail.coverage) {
      expect(entry.work).toBe(catalogue.work);
      const realization = catalogue.realizations.find(item => item.id === entry.realization && item.revision === entry.revision);
      expect(realization, 'coverage pins a retained realization revision').toBeDefined();
      expect(entry.language).toBe(realization!.language);
    }
  }
  for (const expected of catalogue.realizations) {
    const detail = await jsonAnswer<RealizationView>(person.main('GET',
      `${workPath(catalogue.work)}/realizations/${shortId(expected.id)}?revision=${encodeURIComponent(expected.revision)}`));
    expect(detail).toMatchObject({ ...expected, profile: 'realization-v1', work: catalogue.work });
    expect(detail.translators).toEqual(expected.translators);
    expect(detail.sourceEvidence).toEqual(expected.sourceEvidence);
  }
  assertNoHidden({ releases, realizations }, fixture);
  const matches = await selectedReleases(person, catalogue, catalogue.selection);
  expect(matches).toEqual([{ id: catalogue.work, matchedReleases: catalogue.matchingReleases,
    moreMatchedReleases: false }].map(item => expect.objectContaining(item)));
  for (const releaseId of catalogue.matchingReleases) {
    const release = releases.find(item => item.id === releaseId)!;
    expect(release.status).toBe(catalogue.selection.status);
    expect(release.platform).toBe(catalogue.selection.platform);
    const exactEntry = release.coverage.find(entry => entry.work === catalogue.work
      && entry.language === catalogue.selection.language && entry.completeness === catalogue.selection.completeness
      && realizations.some(realization => realization.id === entry.realization && realization.revision === entry.revision
        && realization.translators.includes(catalogue.selection.translator)));
    expect(exactEntry, 'all five conditions need one release and one exact covered realization').toBeDefined();
  }
  for (const example of catalogue.counterexamples) {
    const answer = await selectedReleases(person, catalogue, example.selection);
    expect(answer, example.kind).toEqual([]);
    for (const forbidden of example.forbiddenReleases) expect(JSON.stringify(answer)).not.toContain(forbidden);
    if (example.kind === 'publication-event') {
      expect(example.descriptiveEvent).toBeTruthy();
      expect(releases.map(release => release.id)).not.toContain(example.descriptiveEvent!);
    }
  }
}

async function imageOnBusinessPage(person: PersonaSession, expected: ImageExpectation) {
  const page = await jsonAnswer<BusinessPage>(person.main('GET', pagePath(expected.resource)));
  expect(page.summary.reference).toBe(expected.resource);
  const avatar = page.summary.avatar;
  expect(avatar.kind, `${expected.role} must be usable on the ordinary resource page`).toBe('image');
  const image = avatar as PageImage;
  expect(image).toMatchObject({ role: expected.role, mediaType: expected.mediaType,
    width: expected.width, height: expected.height, crop: expected.crop,
    coverCredit: expected.credit, sourceEvidence: expected.source, rights: expected.rights });
  expect(image.selection).toBeTruthy();
  if (expected.role === 'cover') {
    expect(page.work?.id).toBe(expected.resource);
    expect(page.work?.cover).toEqual(avatar); // No showcase/hero/logo prerequisite.
  } else expect(page.work).toBeNull(); // Portrait is attached to its Character, not the Work.
  const original = retainedBytes(expected.original);
  const metadata = await sharp(original).metadata();
  expect(metadata.width).toBe(expected.originalDimensions.width);
  expect(metadata.height).toBe(expected.originalDimensions.height);
  if (expected.delivery === 'official-reference') {
    // Official references are an authorized test boundary; no live fetch/capture here.
    expect(image.url).toBe(expected.originalUrl);
    expect(new URL(image.url).protocol).toBe('https:');
  } else {
    const url = new URL(image.url, 'http://main.test');
    expect(url.pathname).toMatch(/^\/v1\/media\/representations\/[0-9a-f-]{36}\/bytes$/);
    expect(url.searchParams.get('use')).toBeTruthy();
    const response = await person.main('GET', url.pathname + url.search);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe(expected.mediaType);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(digest(bytes)).toBe(expected.representationBytes.sha256);
    expect(bytes.byteLength).toBe(expected.representationBytes.byteLength);
    const delivered = await sharp(bytes).metadata();
    expect(delivered.width).toBe(expected.width);
    expect(delivered.height).toBe(expected.height);
  }
  assertNoHidden(page, prepared.fixture);
}

async function mediaDispositions(person: PersonaSession) {
  for (const expected of prepared.fixture.mediaDispositions) {
    const page = await jsonAnswer<BusinessPage>(person.main('GET', pagePath(expected.resource)));
    expect(page.mediaDispositions).toContainEqual(expected);
    expect(page.summary.avatar.kind).toBe('fallback');
    expect(JSON.stringify(page.summary.avatar)).not.toContain('url');
  }
}

async function disclosureControls(person: PersonaSession) {
  const { hidden } = prepared.fixture;
  const unknown = await jsonAnswer<Record<string, unknown>>(person.main('GET', workPath(hidden.absentWork)), 404);
  const restricted = await jsonAnswer<Record<string, unknown>>(person.main('GET', workPath(hidden.work)), 404);
  expect(restricted).toEqual(unknown);
  const work = prepared.fixture.catalogues[0]!.work;
  const missingRelease = await jsonAnswer(person.main('GET', `${workPath(work)}/releases/${shortId(hidden.absentRelease)}`), 404);
  expect(await jsonAnswer(person.main('GET', `${workPath(work)}/releases/${shortId(hidden.release)}`), 404)).toEqual(missingRelease);
  // Withdrawn identity can remain in history; it cannot be a selectable ordinary release.
  for (const { release, revision } of [{ release: hidden.release, revision: hidden.releaseRevision },
    { release: hidden.withdrawnRelease, revision: hidden.withdrawnReleaseRevision }]) {
    const reader = person.actingSubject ? person : prepared.sessions.stranger;
    const before = await jsonAnswer(reader.main('GET', `/v1/me/edition-preferences/${shortId(work)}?${actorQuery(reader)}`));
    const response = await person.main('PUT', `/v1/me/edition-preferences/${shortId(work)}`, {
      actingSubject: reader.actingSubject, expectedVersion: (before as Preference | null)?.version ?? 0,
      language: prepared.fixture.catalogues[0]!.selection.language,
      edition: { kind: 'release', resource: release, revision },
    }, `unusable-choice:${shortId(release)}:${shortId(reader.actingSubject!)}`);
    const denied = await response.json() as { code: string };
    if (!person.actingSubject) expect(response.status).toBe(401);
    else if (release === hidden.release) expect(response.status).toBe(404);
    else {
      expect(response.status).toBe(400);
      expect(denied.code).toBe('invalid_edition_preference');
    }
    expect(await jsonAnswer(reader.main('GET', `/v1/me/edition-preferences/${shortId(work)}?${actorQuery(reader)}`))).toEqual(before);
  }
  const portrait = await person.main('GET', pagePath(hidden.portrait));
  expect(portrait.status).toBe(404);
  expect(await portrait.text()).not.toContain(hidden.marker);
  for (const suffix of ['', '/bytes']) {
    const path = (image: { representation: string; use: string }) =>
      `/v1/media/representations/${image.representation}${suffix}?use=${image.use}`;
    const missing = await jsonAnswer(person.main('GET', path(hidden.absentMedia)), 404);
    for (const image of [hidden.privateMedia, hidden.withdrawnMedia]) {
      expect(await jsonAnswer(person.main('GET', path(image)), 404)).toEqual(missing);
    }
  }
}

async function readerIsolation(name: PersonaName) {
  const { fixture, sessions } = prepared;
  const person = sessions[name], reading = fixture.reading;
  const victim = sessions[name === 'owner' ? 'member' : 'owner'];
  const preferencePath = `/v1/me/edition-preferences/${shortId(reading.work)}`;
  const progressPath = `/v1/compositions/${shortId(reading.structure)}/occurrences/${shortId(reading.occurrence)}/progress`;
  const progressQuery = (reader: PersonaSession) => `${actorQuery(reader)}&selectedRevision=${encodeURIComponent(reading.contentRevision)}`;
  const before = await jsonAnswer(victim.main('GET', `${preferencePath}?${actorQuery(victim)}`));
  const beforeProgress = await jsonAnswer(victim.main('GET', `${progressPath}?${progressQuery(victim)}`));
  const pin = { kind: 'release', resource: reading.release, revision: reading.releaseRevision };
  const input = { actingSubject: victim.actingSubject, expectedVersion: (before as Preference | null)?.version ?? 0,
    language: reading.language, edition: pin };
  const deniedStatus = name === 'visitor' ? 401 : 403;
  await jsonAnswer(person.main('GET', `${preferencePath}?${actorQuery(victim)}`), deniedStatus);
  await jsonAnswer(person.main('PUT', preferencePath, input, `foreign-choice:${name}`), deniedStatus);
  await jsonAnswer(person.main('GET', `${progressPath}?${progressQuery(victim)}`), deniedStatus);
  await jsonAnswer(person.main('PUT', progressPath, { actingSubject: victim.actingSubject,
    expectedVersion: (beforeProgress as { version: number }).version, selectedRevision: reading.contentRevision,
    completed: false, position: reading.position }, `foreign-progress:${name}`), deniedStatus);
  expect(await jsonAnswer(victim.main('GET', `${preferencePath}?${actorQuery(victim)}`))).toEqual(before);
  expect(await jsonAnswer(victim.main('GET', `${progressPath}?${progressQuery(victim)}`))).toEqual(beforeProgress);
  if (name === 'visitor') return;
  const ownBefore = await jsonAnswer<Preference | null>(person.main('GET', `${preferencePath}?${actorQuery(person)}`));
  const body = { ...input, actingSubject: person.actingSubject, expectedVersion: ownBefore?.version ?? 0 };
  const saved = await jsonAnswer<Preference & { replayed: boolean }>(person.main('PUT', preferencePath, body, `choice:${name}`));
  expect(saved).toMatchObject({ work: reading.work, language: reading.language, edition: pin, version: body.expectedVersion + 1 });
  expect(await jsonAnswer(person.main('PUT', preferencePath, body, `choice:${name}`))).toEqual({ ...saved, replayed: true });
  expect(await jsonAnswer(person.main('GET', `${preferencePath}?${actorQuery(person)}`))).toMatchObject({ edition: pin, language: reading.language, version: saved.version });
  const realization = { kind: 'realization', resource: reading.realization, revision: reading.realizationRevision };
  const stale = await jsonAnswer<{ current: Preference }>(person.main('PUT', preferencePath,
    { ...body, edition: realization }, `stale-choice:${name}`), 409);
  expect(stale.current).toMatchObject({ edition: pin, version: saved.version });
  const selectedText = await jsonAnswer<Preference>(person.main('PUT', preferencePath,
    { ...body, expectedVersion: saved.version, edition: realization }, `text-choice:${name}`));
  expect(selectedText).toMatchObject({ edition: realization, version: saved.version + 1 });
  const summaryPath = `/v1/me/progress-summaries/${shortId(reading.work)}?${actorQuery(person)}&language=${reading.language}`;
  expect(await jsonAnswer(person.main('GET', summaryPath))).toMatchObject({ preference: {
    language: reading.language, edition: realization, version: selectedText.version } });
  const progressBefore = await jsonAnswer<{ version: number }>(person.main('GET', `${progressPath}?${progressQuery(person)}`));
  const progressBody = { actingSubject: person.actingSubject, expectedVersion: progressBefore.version,
    selectedRevision: reading.contentRevision, completed: false, position: reading.position };
  const progress = await jsonAnswer<{ version: number; replayed: boolean }>(person.main('PUT', progressPath, progressBody, `progress:${name}`));
  expect(progress).toMatchObject({ structure: reading.structure, occurrence: reading.occurrence,
    selectedRevision: reading.contentRevision, position: reading.position, completed: false, version: progressBefore.version + 1 });
  expect(await jsonAnswer(person.main('PUT', progressPath, progressBody, `progress:${name}`))).toEqual({ ...progress, replayed: true });
  expect(await jsonAnswer(person.main('GET', `${progressPath}?${progressQuery(person)}`))).toMatchObject({ position: reading.position,
    selectedRevision: reading.contentRevision, version: progress.version });
  const resume = await jsonAnswer<{ resolved: string; items: Array<{ occurrence: string; target: string }> }>(person.main('GET',
    `/v1/reading-positions/${shortId(reading.work)}?${actorQuery(person)}&position=mine`));
  expect(resume.resolved).toBe(reading.occurrence);
  expect(resume.items).toContainEqual(expect.objectContaining({ occurrence: reading.occurrence, target: reading.chapter }));
  // A new HTTP read, with no page-local choice state, returns the persisted pins.
  const returned = person.snapshot();
  expect(await jsonAnswer(returned.main('GET', `${preferencePath}?${actorQuery(person)}`))).toMatchObject({ edition: realization });
  expect(await jsonAnswer(returned.main('GET', `${progressPath}?${progressQuery(person)}`))).toMatchObject({ selectedRevision: reading.contentRevision, position: reading.position });
  expect(await jsonAnswer(victim.main('GET', `${preferencePath}?${actorQuery(victim)}`))).toEqual(before);
  expect(await jsonAnswer(victim.main('GET', `${progressPath}?${progressQuery(victim)}`))).toEqual(beforeProgress);
}

// Every persona exercises each independent obligation even while other contracts fail.
async function releasesAndMedia(name: PersonaName) {
  const failures: unknown[] = [];
  const person = prepared.sessions[name];
  const obligations: Array<[string, () => Promise<void>]> = [
    ...prepared.fixture.catalogues.map(catalogue => [`C10/C20 ${catalogue.provider}`, () => nativeChoices(person, catalogue)] as [string, () => Promise<void>]),
    ...prepared.fixture.images.map(image => [`C12/C13 ${image.role} ${image.source.provider}`, () => imageOnBusinessPage(person, image)] as [string, () => Promise<void>]),
    ['C12 media refusal dispositions', () => mediaDispositions(person)],
    ['private and withdrawn controls', () => disclosureControls(person)],
    ['C11 reader isolation and return', () => readerIsolation(name)],
  ];
  for (const [label, prove] of obligations) {
    try { await prove(); }
    catch (error) { failures.push(new Error(`${name}: ${label}`, { cause: error })); }
  }
  if (failures.length) throw new AggregateError(failures, `${name}: ${failures.length} release/media obligations failed`);
}

outcomeTest(outcomes, 'visitor', () => releasesAndMedia('visitor'));
outcomeTest(outcomes, 'stranger', () => releasesAndMedia('stranger'));
outcomeTest(outcomes, 'member', () => releasesAndMedia('member'));
outcomeTest(outcomes, 'owner', () => releasesAndMedia('owner'));
outcomeTest(outcomes, 'moderator', () => releasesAndMedia('moderator'));
outcomeTest(outcomes, 'operator', () => releasesAndMedia('operator'));
