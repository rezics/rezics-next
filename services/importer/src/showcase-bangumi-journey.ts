/** Run the selected anime and light-novel journey under the bounded local stack.
 *
 *   bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/showcase-bangumi-journey.ts
 *
 * `walk` owns the slot, ports, database, search, dependency order, and teardown. This driver seeds and reads only through
 * the initialized services, so an unfinished journey cannot leave its infrastructure running.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { CrossMediaSeedReport } from './cross-media-seed.ts';
import type { ShowcasePublicationResult } from './showcase-publication.ts';

const root = resolve(import.meta.dir, '../../..');
const evidence = resolve(root, '.temp/anime-journey', randomUUID().slice(0, 8));
const privateLogs = resolve(root, '.temp/anime-stack', randomUUID().slice(0, 8));
const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 900 },
} as const;

/** One published selected Bangumi record the journey visits; its role decides which public reads apply. */
export type JourneyTarget = {
  sourceKey: string;
  role: 'anime' | 'series' | 'volume';
  /** The BookSeries a volume belongs to, by its Bangumi key. */
  series?: string;
};

export const journeyTargets: readonly JourneyTarget[] = [
  { sourceKey: '10380', role: 'anime' },
  { sourceKey: '51', role: 'anime' },
  { sourceKey: '233', role: 'anime' },
  { sourceKey: '499', role: 'series' },
  { sourceKey: '26', role: 'volume', series: '499' },
  { sourceKey: '2815', role: 'series' },
  { sourceKey: '5329', role: 'volume', series: '2815' },
  { sourceKey: '10862', role: 'volume', series: '2815' },
];

export type JourneyPublishedRow = {
  provider: string;
  sourceKey: string;
  subjectId: string;
  nativeType: string;
  readerRoute: string | null;
  assertions: readonly { property?: string; citations?: readonly string[] | undefined }[];
};

export type JourneyWork<Row extends JourneyPublishedRow = JourneyPublishedRow> = JourneyTarget & { row: Row };

/**
 * Pick each journey target from the composed publication. A missing or duplicated record stops the walk before any
 * browser effect, and malformed publication rows are rejected at this generated-file boundary.
 */
export function selectJourneyWorks<Row extends JourneyPublishedRow>(published: readonly Row[]): JourneyWork<Row>[] {
  for (const [index, raw] of (published as readonly unknown[]).entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.provider !== 'string' ||
      typeof raw.sourceKey !== 'string' ||
      typeof raw.subjectId !== 'string' ||
      typeof raw.nativeType !== 'string' ||
      (raw.readerRoute !== null && typeof raw.readerRoute !== 'string') ||
      !Array.isArray(raw.assertions) ||
      raw.assertions.some(
        (assertion) =>
          !isRecord(assertion) ||
          (assertion.property !== undefined && typeof assertion.property !== 'string') ||
          (assertion.citations !== undefined &&
            (!Array.isArray(assertion.citations) ||
              assertion.citations.some((citation) => typeof citation !== 'string'))),
      )
    )
      throw new TypeError(`published showcase row ${index} has an invalid identity or assertions`);
  }
  return journeyTargets.map((target) => {
    const rows = published.filter((row) => row.provider === 'bangumi' && row.sourceKey === target.sourceKey);
    if (rows.length !== 1) throw new Error(`journey target bangumi:${target.sourceKey} has ${rows.length} rows`);
    const row = rows[0]!;
    if (
      typeof row.subjectId !== 'string' ||
      !row.subjectId ||
      typeof row.nativeType !== 'string' ||
      !row.nativeType ||
      typeof row.readerRoute !== 'string' ||
      !row.readerRoute.startsWith('/subjects/') ||
      !Array.isArray(row.assertions)
    )
      throw new TypeError(`journey target bangumi:${target.sourceKey} has an invalid published identity`);
    return { ...target, row };
  });
}

function requiredOrigin(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run this command under dev-stack.ts walk`);
  return value;
}

let phase = 'readiness';

async function command(name: string, args: string[]) {
  console.info(`Anime journey: ${name}`);
  await mkdir(privateLogs, { recursive: true, mode: 0o700 });
  const log = Bun.file(resolve(privateLogs, `${name}.log`));
  const child = Bun.spawn(args, { cwd: root, env: process.env, stdout: log, stderr: log });
  const code = await child.exited;
  if (code !== 0) {
    const lines = (await log.text()).split('\n');
    const error = lines.find((line) => /^(?:error:|Error:|remote-check:.*failed|task: Failed)/.test(line));
    throw new Error(`${name} exited ${code}${error ? `: ${error}` : ''}`);
  }
}

async function ready(origin: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Stack origin did not become ready: ${origin}`);
}

type Statement = {
  id?: string;
  property?: { id?: string };
  value?: { type?: string; content?: unknown };
  references?: readonly {
    parts?: readonly { property?: { id?: string }; value?: { type?: string; content?: unknown } }[];
  }[];
};
type PublicSubject = {
  subject: { id: string; type: string; statements: Record<string, Statement[] | undefined> };
};
export type JourneyBrowserTarget = {
  id: string;
  property: string;
  citation: string;
  statementId: string;
  holder: string;
  kind: 'episode' | 'person' | 'organization' | 'book' | 'book-series' | 'anime';
};
type PublicLink = {
  subject: string;
  property: string;
  statement: string;
  assertion?: Statement;
  summary: { id: string; type: string };
};

const animeStaffProperties = [
  'schema:author',
  'schema:director',
  'schema:contributor',
  'schema:musicBy',
  'wdt:P6942',
  'schema:editor',
  'schema:lyricist',
  'schema:producer',
  'schema:productionCompany',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function citationUrls(statement: Statement): string[] {
  return (statement.references ?? [])
    .flatMap((reference) => reference.parts ?? [])
    .filter((part) => part.property?.id === 'schema:url' && part.value?.type === 'value')
    .map((part) => part.value?.content)
    .filter((value): value is string => typeof value === 'string');
}

/** Only current, cited Bangumi staff or cast rows become reader targets. */
export function citedAnimeCreditTargets(
  read: PublicSubject,
  sourceKey: string,
  role: 'cast' | 'staff',
): JourneyBrowserTarget[] {
  const properties = role === 'cast' ? ['wdt:P725'] : animeStaffProperties;
  const sourcePath = role === 'cast' ? '/person-characters/' : '/subject-persons/';
  const prefix = `https://bgm.tv/subject/${sourceKey}#${sourcePath}${sourceKey}/`;
  const targets: JourneyBrowserTarget[] = [];
  const seen = new Set<string>();
  for (const property of properties) {
    for (const statement of read.subject.statements[property] ?? []) {
      const id = statement.value?.type === 'value' ? statement.value.content : undefined;
      if (typeof id !== 'string' || typeof statement.id !== 'string') continue;
      const citation = citationUrls(statement).find((value) => value.startsWith(prefix));
      if (!citation) continue;
      const key = `${property}\0${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        id,
        property,
        citation,
        statementId: statement.id,
        holder: read.subject.id,
        kind: role === 'cast' ? 'person' : property === 'schema:productionCompany' ? 'organization' : 'person',
      });
    }
  }
  return targets;
}

async function currentLinks(api: string, id: string, property: string): Promise<PublicLink[]> {
  const response = await fetch(`${api}/v1/subjects/${id}/links?property=${encodeURIComponent(property)}&limit=100`);
  assert.equal(response.status, 200, `anonymous links ${id} ${property}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.links))
    throw new TypeError(`Current ${property} links for ${id} have an invalid response shape`);
  return body.links.map((raw, index) => {
    if (
      !isRecord(raw) ||
      typeof raw.subject !== 'string' ||
      typeof raw.property !== 'string' ||
      typeof raw.statement !== 'string' ||
      !isRecord(raw.summary) ||
      typeof raw.summary.id !== 'string' ||
      typeof raw.summary.type !== 'string'
    )
      throw new TypeError(`Current ${property} link ${index} for ${id} has an invalid target`);
    return {
      subject: raw.subject,
      property: raw.property,
      statement: raw.statement,
      ...(isRecord(raw.assertion) ? { assertion: raw.assertion as Statement } : {}),
      summary: { id: raw.summary.id, type: raw.summary.type },
    };
  });
}

function targetFromInverseLink(
  link: PublicLink,
  holderId: string,
  property: string,
  expectedType: string,
  citation: (statement: Statement) => string | undefined,
): JourneyBrowserTarget | undefined {
  const statement = link.assertion;
  if (
    link.property !== property ||
    !statement ||
    statement.property?.id !== property ||
    statement.value?.type !== 'value' ||
    statement.value.content !== holderId ||
    link.summary.type !== expectedType
  )
    return;
  const sourceCitation = citation(statement);
  if (!sourceCitation) return;
  const kind =
    expectedType === 'schema:Episode'
      ? 'episode'
      : expectedType === 'schema:Book'
        ? 'book'
        : expectedType === 'schema:BookSeries'
          ? 'book-series'
          : expectedType === 'schema:TVSeries'
            ? 'anime'
            : expectedType === 'schema:Organization'
              ? 'organization'
              : 'person';
  return {
    id: link.summary.id,
    property,
    citation: sourceCitation,
    statementId: link.statement,
    holder: link.subject,
    kind,
  };
}

async function current(api: string, id: string): Promise<PublicSubject> {
  const response = await fetch(`${api}/v1/subjects/${id}`);
  assert.equal(response.status, 200, `anonymous Subject ${id}`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !isRecord(body.subject) ||
    typeof body.subject.id !== 'string' ||
    typeof body.subject.type !== 'string' ||
    !isRecord(body.subject.statements)
  )
    throw new TypeError(`Current Subject ${id} has an invalid response shape`);
  return body as unknown as PublicSubject;
}

/** Exact und-language names on a public Subject; these are the labels the page must show unchanged. */
function undNames(read: PublicSubject): string[] {
  return (read.subject.statements['schema:name'] ?? [])
    .map((statement) => statement.value?.content)
    .filter(
      (content): content is { language: string; text: string } =>
        isRecord(content) && content.language === 'und' && typeof content.text === 'string' && content.text.length > 0,
    )
    .map((content) => content.text);
}

function contents(read: PublicSubject, property: string): unknown[] {
  return (read.subject.statements[property] ?? []).map((statement) => statement.value?.content);
}

function statementTargets(
  read: PublicSubject,
  property: string,
  citations: ReadonlySet<string>,
): JourneyBrowserTarget[] {
  return (read.subject.statements[property] ?? []).flatMap((statement) => {
    const id = statement.value?.type === 'value' ? statement.value.content : undefined;
    if (typeof id !== 'string' || typeof statement.id !== 'string') return [];
    const citation = citationUrls(statement).find((value) => citations.has(value));
    if (!citation) return [];
    const kind = property === 'schema:publisher' ? 'organization' : 'person';
    return [{ id, property, citation, statementId: statement.id, holder: read.subject.id, kind }];
  });
}

function sourceCitations(row: JourneyPublishedRow, property: string): Set<string> {
  return new Set(
    row.assertions
      .filter((assertion) => assertion.property === property)
      .flatMap((assertion) => assertion.citations ?? []),
  );
}

function subjectIdFromCreditCitation(citation: string, role: 'cast' | 'staff', sourceKey: string): string | undefined {
  const path = role === 'cast' ? 'person-characters' : 'subject-persons';
  const expression = new RegExp(`^https://bgm\\.tv/subject/${sourceKey}#/${path}/${sourceKey}/([1-9][0-9]*)/`, 'u');
  return expression.exec(citation)?.[1];
}

function assertCurrentIdentity(read: PublicSubject, target: JourneyBrowserTarget) {
  assert.equal(read.subject.id, target.id, `current identity ${target.id}`);
  const expected =
    target.kind === 'organization'
      ? ['schema:Organization']
      : target.kind === 'person'
        ? ['schema:Person', 'schema:Organization']
        : target.kind === 'episode'
          ? ['schema:Episode']
          : target.kind === 'book'
            ? ['schema:Book']
            : target.kind === 'book-series'
              ? ['schema:BookSeries']
              : ['schema:TVSeries'];
  assert.ok(expected.includes(read.subject.type), `${target.id} is current ${target.kind} (${read.subject.type})`);
}

function browserLinkFor(
  links: readonly { href: string; text: string }[],
  origin: string,
  target: JourneyBrowserTarget,
) {
  return links.find((link) => new URL(link.href, origin).pathname.includes(`/subjects/${target.id}`));
}

async function checkBrowserTarget(
  page: any,
  origin: string,
  sourceId: string,
  target: JourneyBrowserTarget,
  viewport: string,
) {
  const sourcePath = new URL(page.url()).pathname;
  const links = await page
    .locator('main a[href]')
    .evaluateAll((nodes: any[]) =>
      nodes.map((node: any) => ({ href: node.href as string, text: (node.textContent ?? '') as string })),
    );
  const link = browserLinkFor(links, origin, target);
  assert.ok(link, `${viewport} ${sourceId} links to ${target.kind} ${target.id}`);
  const destination = new URL(link.href, origin);
  const via = destination.searchParams.get('via');
  assert.ok(via, `${viewport} ${sourceId} link to ${target.id} carries return navigation`);
  assert.equal(new URL(via!, origin).pathname, new URL(page.url()).pathname, `${target.id} returns to its holder`);
  await page
    .locator(`[data-work-holder="${target.holder}"][data-work-statement="${target.statementId}"]`)
    .locator('[data-work-action="evidence"]')
    .click();
  const card = page.locator(`[data-work-holder="${target.holder}"][data-work-statement="${target.statementId}"]`);
  const citations = await card
    .locator('a[href]')
    .evaluateAll((nodes: any[]) => nodes.map((node: any) => node.href as string));
  assert.ok(citations.includes(target.citation), `${viewport} ${sourceId} ${target.property} shows ${target.citation}`);
  await page.locator(`main a[href*="/subjects/${target.id}"]`).first().click();
  await page.waitForURL((url: URL) => url.pathname.includes(`/subjects/${target.id}`), { timeout: 30_000 });
  await page.goBack({ waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).pathname, sourcePath, `${target.id} returns to ${sourceId}`);
}

async function checkTarget(work: JourneyWork, subjectIds: ReadonlyMap<string, string>, api: string) {
  const read = await current(api, work.row.subjectId);
  assert.equal(read.subject.id, work.row.subjectId, `${work.sourceKey} remains independently current`);
  assert.equal(read.subject.type, work.row.nativeType, `${work.sourceKey} current native type`);
  const citation = `https://bgm.tv/subject/${work.sourceKey}`;
  assert.ok(
    work.row.assertions.some((row) => row.citations?.includes(citation)),
    `${work.sourceKey} cites ${citation}`,
  );
  if (['10380', '51'].includes(work.sourceKey)) {
    for (const property of ['schema:datePublished', 'schema:numberOfEpisodes'])
      assert.ok(read.subject.statements[property]?.length, `${work.sourceKey} current ${property}`);
  }
  if (work.role === 'series') {
    assert.equal(read.subject.type, 'schema:BookSeries', `${work.sourceKey} is a BookSeries`);
    assert.ok(undNames(read).length > 0, `${work.sourceKey} has an exact und name`);
  }
  if (work.role === 'volume') {
    assert.equal(read.subject.type, 'schema:Book', `${work.sourceKey} is a Book`);
    assert.ok(undNames(read).length > 0, `${work.sourceKey} has an exact und name`);
    const series = subjectIds.get(work.series!);
    assert.ok(series, `series ${work.series} is published`);
    assert.ok(contents(read, 'wdt:P179').includes(series), `${work.sourceKey} is a current volume of ${work.series}`);
  }
  return { read, citation };
}

export async function runBangumiJourney() {
  const web = requiredOrigin('REZICS_LOCAL_STACK_WEB_ORIGIN');
  const issuer = requiredOrigin('REZICS_LOCAL_STACK_ISSUER_ORIGIN');
  const api = requiredOrigin('REZICS_LOCAL_STACK_KERNEL_ORIGIN');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await mkdir(privateLogs, { recursive: true, mode: 0o700 });
  // `walk` has initialized the issuer and workflow worker before Kernel and Web.
  await ready(`${issuer}/.well-known/openid-configuration`);
  await ready(api);
  await ready(web);
  phase = 'persona';
  await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
  phase = 'seed';
  await command('seed', [
    'bun',
    '--env-file=.temp/local-stack/seed.env',
    'scripts/datasets/cross-media-seed.ts',
    '--dev',
  ]);
  const reportValue: unknown = JSON.parse(await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8'));
  if (!isRecord(reportValue) || !isRecord(reportValue.showcase) || !Array.isArray(reportValue.showcase.published))
    throw new TypeError('Cross-media seed result has no published showcase identities');
  const report = reportValue as unknown as CrossMediaSeedReport;
  const publication = report.showcase as ShowcasePublicationResult;
  const works = selectJourneyWorks(publication.published);
  const subjectIds = new Map(works.map((work) => [work.sourceKey, work.row.subjectId]));
  const publishedByKey = new Map(publication.published.map((row) => [`${row.provider}:${row.sourceKey}`, row]));
  const publishedById = new Map(publication.published.map((row) => [row.subjectId, row]));
  const currentReads = new Map<string, PublicSubject>();
  phase = 'anonymous-api';
  const workReads: { sourceKey: string; role: JourneyTarget['role']; id: string; route: string; citation: string }[] =
    [];
  for (const work of works) {
    const { read, citation } = await checkTarget(work, subjectIds, api);
    currentReads.set(work.sourceKey, read);
    workReads.push({
      sourceKey: work.sourceKey,
      role: work.role,
      id: work.row.subjectId,
      route: work.row.readerRoute!,
      citation,
    });
  }

  const browserTargets = new Map<string, JourneyBrowserTarget[]>();
  const keepTargets = (key: string, targets: readonly JourneyBrowserTarget[]) => browserTargets.set(key, [...targets]);
  const bookSeriesTargets = new Map<string, { publishers: JourneyBrowserTarget[]; volumes: JourneyBrowserTarget[] }>();
  for (const seriesKey of ['499', '2815']) {
    const seriesWork = works.find((work) => work.sourceKey === seriesKey)!;
    const read = currentReads.get(seriesKey)!;
    const publishers = statementTargets(read, 'schema:publisher', sourceCitations(seriesWork.row, 'schema:publisher'));
    assert.ok(publishers.length, `series ${seriesKey} has a current cited publisher`);
    for (const target of publishers) assertCurrentIdentity(await current(api, target.id), target);
    const familyVolumes = currentLinks(api, seriesWork.row.subjectId, 'wdt:P179').then((links) => {
      const currentTargets = links.flatMap((link) => {
        const row = publishedById.get(link.summary.id);
        const allowed = row ? sourceCitations(row, 'wdt:P179') : new Set<string>();
        return row && row.provider === 'bangumi'
          ? [
              targetFromInverseLink(link, seriesWork.row.subjectId, 'wdt:P179', 'schema:Book', (statement) =>
                citationUrls(statement).find((url) => allowed.has(url)),
              ),
            ].filter((target): target is JourneyBrowserTarget => target !== undefined)
          : [];
      });
      return currentTargets;
    });
    const volumes = await familyVolumes;
    assert.ok(volumes.length, `series ${seriesKey} has current volume links`);
    const requiredVolumes = seriesKey === '499' ? ['26'] : ['5329', '10862'];
    for (const requiredVolume of requiredVolumes)
      assert.ok(
        volumes.some((target) => target.id === subjectIds.get(requiredVolume)),
        `series ${seriesKey} has the pinned volume ${requiredVolume} through inverse wdt:P179`,
      );
    for (const target of volumes) assertCurrentIdentity(await current(api, target.id), target);
    bookSeriesTargets.set(seriesKey, { publishers, volumes });
    keepTargets(seriesKey, [publishers[0]!, ...volumes]);
  }

  const kara = works.find((work) => work.sourceKey === '2815')!;
  const anime = works.find((work) => work.sourceKey === '233')!;
  const animeWorkRead = currentReads.get('233')!;
  const animeRow = anime.row;
  const counterpartLinks = await currentLinks(api, kara.row.subjectId, 'rezics:crossMediaCounterpart');
  const animeCounterpartCitations = new Set([
    ...sourceCitations(animeRow, 'rezics:crossMediaCounterpart'),
    ...sourceCitations(kara.row, 'rezics:crossMediaCounterpart'),
  ]);
  const counterpart = counterpartLinks.flatMap((link) => {
    const row = publishedById.get(link.summary.id);
    if (row?.subjectId !== anime.row.subjectId) return [];
    const target = targetFromInverseLink(
      link,
      kara.row.subjectId,
      'rezics:crossMediaCounterpart',
      'schema:TVSeries',
      (statement) => citationUrls(statement).find((url) => animeCounterpartCitations.has(url)),
    );
    return target ? [target] : [];
  });
  assert.equal(counterpart.length, 1, '2815 reaches the current anime 233 counterpart with its source citation');
  assertCurrentIdentity(await current(api, counterpart[0]!.id), counterpart[0]!);
  keepTargets('2815', [...browserTargets.get('2815')!, counterpart[0]!]);

  const episodeLinks = await currentLinks(api, anime.row.subjectId, 'schema:isPartOf');
  const episodes = episodeLinks.flatMap((link) => {
    const target = targetFromInverseLink(link, anime.row.subjectId, 'schema:isPartOf', 'schema:Episode', (statement) =>
      citationUrls(statement).find((url) => {
        const match = /^https:\/\/bgm\.tv\/ep\/([1-9][0-9]*)$/u.exec(url);
        return (
          !!match &&
          bangumiRecordUrl(`episode:${match[1]}`) === url &&
          publishedByKey.get(`bangumi:episode:${match[1]}`)?.subjectId === link.summary.id
        );
      }),
    );
    return target ? [target] : [];
  });
  assert.ok(episodes.length, 'anime 233 has a current cited inverse episode target');
  for (const target of episodes) assertCurrentIdentity(await current(api, target.id), target);

  const cast = citedAnimeCreditTargets(animeWorkRead, '233', 'cast').filter((target) => {
    const sourcePerson = subjectIdFromCreditCitation(target.citation, 'cast', '233');
    return sourcePerson !== undefined && publishedByKey.get(`bangumi:person:${sourcePerson}`)?.subjectId === target.id;
  });
  const staff = citedAnimeCreditTargets(animeWorkRead, '233', 'staff').filter((target) => {
    const sourcePerson = subjectIdFromCreditCitation(target.citation, 'staff', '233');
    return sourcePerson !== undefined && publishedByKey.get(`bangumi:person:${sourcePerson}`)?.subjectId === target.id;
  });
  assert.ok(cast.length, 'anime 233 has a current cited Bangumi voice-cast target');
  assert.ok(staff.length, 'anime 233 has a current cited Bangumi staff target');
  for (const target of [...cast, ...staff]) assertCurrentIdentity(await current(api, target.id), target);
  keepTargets('233', [episodes[0]!, cast[0]!, staff[0]!]);

  // Preserve independently current public identities and their exact source evidence for diagnosis.
  await writeFile(
    resolve(evidence, 'native.json'),
    JSON.stringify(
      {
        works: workReads,
        relations: {
          bookSeries: Object.fromEntries(bookSeriesTargets),
          counterpart,
          episodes,
          cast,
          staff,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  phase = 'anonymous-browser';
  const browser = await chromium.launch({ headless: true });
  try {
    const visits: {
      viewport: string;
      sourceKey: string;
      url: string;
      text: string;
      targets: JourneyBrowserTarget[];
    }[] = [];
    for (const [name, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport, locale: 'en-US' });
      const page = await context.newPage();
      try {
        for (const work of works) {
          const route = work.row.readerRoute;
          assert.ok(route, `journey target bangumi:${work.sourceKey} has no reader route`);
          const response = await page.goto(`${web}/en${route}`);
          assert.equal(response?.status(), 200, `mounted ${name} work ${work.sourceKey}`);
          await page.locator('main').waitFor();
          const text = await page.locator('main').innerText();
          visits.push({
            viewport: name,
            sourceKey: work.sourceKey,
            url: page.url(),
            text,
            targets: browserTargets.get(work.sourceKey) ?? [],
          });
          const read = currentReads.get(work.sourceKey)!;
          for (const label of undNames(read))
            assert.ok(text.includes(label), `${name} ${work.sourceKey} shows und name ${label}`);
          assert.ok(
            (await page.locator('main a[href*="bgm.tv"]').count()) > 0,
            `${name} ${work.sourceKey} renders its Bangumi citation`,
          );
          for (const target of browserTargets.get(work.sourceKey) ?? [])
            await checkBrowserTarget(page, web, work.row.subjectId, target, name);
          // Required visits are the selected comic, both Kara volumes, the anime counterpart and anime detail targets.
          if (work.sourceKey === '26')
            assert.ok(text.includes('文学少女'), `${name} Book Girl volume retains its exact title`);
          if (work.sourceKey === '233')
            assert.ok(text.includes('劇場版 空の境界 第一章 俯瞰風景'), `${name} anime 233 shows its exact und name`);
        }
      } finally {
        await context.close();
      }
    }
    await writeFile(resolve(evidence, 'browser.json'), JSON.stringify(visits, null, 2), { mode: 0o600 });
  } finally {
    await browser.close();
  }
  phase = 'complete';
}

if (import.meta.main) {
  try {
    await runBangumiJourney();
  } finally {
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    await writeFile(resolve(evidence, 'phase.json'), JSON.stringify({ phase }), { mode: 0o600 });
  }
}
