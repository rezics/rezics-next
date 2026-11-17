import { randomUUID } from 'node:crypto';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { FIRST_PUBLIC_JOURNEYS, type FirstPublicJourneyId } from './semantic-first-public-inventory.ts';
import {
  acceptCandidate,
  adoptCandidate,
  cited,
  citedDocument,
  citedQuantity,
  createContext,
  createStaticZone,
  createSubject,
  deleteCandidate,
  deleteZone,
  discloseStatement,
  MINUTE,
  patchTerms,
  propose,
  publishZone,
  readActiveDefinitions,
  readSubject,
  readZonePage,
  requireStatus,
  restoreCandidate,
  restoreZone,
  retractStatement,
  saveZoneConfiguration,
  searchType,
  subjectHref,
  subjectId,
  subjectRevision,
  takedownZone,
  type Json,
} from './semantic-first-public-native.ts';
import {
  createAndRead,
  visit,
  type MountedSubjectDiagnostic,
  type SemanticBrowserSession,
  type SemanticPageObservation,
} from './semantic-first-public-browser.ts';
import type { NativeObservation } from './semantic-first-public-request.ts';

export type SemanticFirstPublicResult = {
  id: FirstPublicJourneyId;
  name: string;
  status: 'Passing' | 'Failing' | 'Aborted';
  ms: number;
  persona: string;
  native?: unknown;
  commands?: NativeObservation[];
  browser?: unknown;
  mountedSubject?: MountedSubjectDiagnostic;
  pages?: SemanticPageObservation[];
  abort?: { reason: 'lifecycle' };
  failure?: { transition: string; expected: string; actual: string; owner: string };
};

export type SemanticFirstPublicSession = SemanticBrowserSession & {
  trace: NativeObservation[];
  outsider?: string;
  revision: string;
  editorAgent: () => Promise<{ id: string }>;
  editorAgentCause?: string;
  editorCause?: string;
  refreshEditor?: () => Promise<void>;
  signal?: AbortSignal;
};

function ownerOf(error: string): string {
  if (/hydrat|locator|html\[data-hydrated\]/i.test(error)) return 'unclassified';
  if (/playwright|heap out of memory/i.test(error)) return 'web';
  if (/search|opensearch|index/i.test(error)) return 'search';
  if (/licence|authored/i.test(error)) return 'content';
  if (/import|provider/i.test(error)) return 'imports';
  if (/auth|sign-in|401|403|invalid_credentials|suspended/i.test(error)) return 'accounts';
  return 'semantic';
}

function fail(transition: string, expected: string, actual: string, owner = ownerOf(actual)) {
  return { transition, expected, actual: actual.slice(0, 800), owner };
}

export function failingRow(
  row: (typeof FIRST_PUBLIC_JOURNEYS)[number],
  cause: string,
  persona = 'setup',
): SemanticFirstPublicResult {
  return {
    id: row.id,
    name: row.name,
    status: 'Failing',
    ms: 0,
    persona,
    failure: fail(row.id, row.native, cause, ownerOf(cause)),
  };
}

async function journey(
  session: SemanticFirstPublicSession,
  id: FirstPublicJourneyId,
  run: () => Promise<{ native?: unknown; browser?: unknown; persona?: string }>,
): Promise<SemanticFirstPublicResult> {
  const meta = FIRST_PUBLIC_JOURNEYS.find((row) => row.id === id)!;
  const started = Date.now();
  const traceOffset = session.trace.length;
  const pageOffset = session.pages?.length ?? 0;
  const pageEvidence = () => (session.pages ? { pages: session.pages.slice(pageOffset) } : {});
  const mountedSubjectEvidence = () =>
    id === 'generic-creation' && session.mountedSubject ? { mountedSubject: session.mountedSubject } : {};
  try {
    session.signal?.throwIfAborted();
    await session.refreshEditor?.();
    session.signal?.throwIfAborted();
    const observed = await run();
    return {
      id,
      name: meta.name,
      status: 'Passing',
      ms: Date.now() - started,
      persona: observed.persona ?? 'editor+anonymous',
      native: observed.native,
      commands: session.trace.slice(traceOffset),
      browser: observed.browser,
      ...pageEvidence(),
      ...mountedSubjectEvidence(),
    };
  } catch (error) {
    if (session.signal?.aborted)
      return {
        id,
        name: meta.name,
        status: 'Aborted',
        ms: Date.now() - started,
        persona: 'editor+anonymous',
        abort: { reason: 'lifecycle' },
        commands: session.trace.slice(traceOffset),
        ...pageEvidence(),
        ...mountedSubjectEvidence(),
      };
    const actual = error instanceof Error ? error.message : String(error);
    return {
      id,
      name: meta.name,
      status: 'Failing',
      ms: Date.now() - started,
      persona: 'editor+anonymous',
      commands: session.trace.slice(traceOffset),
      ...mountedSubjectEvidence(),
      ...pageEvidence(),
      failure: fail(
        session.trace.at(-1)?.status && session.trace.at(-1)!.status! >= 400
          ? `${session.trace.at(-1)!.method} ${session.trace.at(-1)!.url}`
          : id,
        meta.native,
        actual,
      ),
    };
  }
}

async function releasedDefinitions(
  session: SemanticFirstPublicSession,
): Promise<{ native: unknown; browser: unknown }> {
  const { digest } = await readActiveDefinitions(session.call);
  const release = await session.call('GET', `/v1/definitions/releases/${encodeURIComponent(digest)}`);
  requireStatus(release, 200, 'release');
  const book = (
    release.body.release as { types: Record<string, { labels: Record<string, string>; properties: string[] }> }
  ).types['schema:Book'];
  if (!book?.properties.includes('schema:author')) throw new Error('schema:Book omitted schema:author');
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    if (!book.labels[locale]) throw new Error(`schema:Book omitted ${locale} label`);
  }
  const types = await session.call('GET', '/v1/definitionTypes', { query: { typeId: 'schema:Book', locale: 'en' } });
  const browser = [];
  for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
    const width = locale === 'ja' ? 390 : 1280;
    const theme = locale === 'zh-Hant' ? 'dark' : 'light';
    browser.push(
      await visit(
        session,
        `${session.stack.web}/${locale}/catalogue/definitions?type=${encodeURIComponent('schema:Book')}`,
        {
          width,
          theme,
        },
      ),
    );
  }
  return { native: { digest, typeStatus: types.status, author: true }, browser };
}

export function semanticFirstPublicCases(session: SemanticFirstPublicSession, token = randomUUID().slice(0, 8)) {
  const { call, stack } = session;
  let termsBookId = '';
  let contextId = '';
  const zoneLabel = `Walk zone ${token}`;
  const zoneHome = `Walk zone home ${token}`;
  const zoneAbout = `Walk zone about ${token}`;
  let zoneId = '';
  let zoneRevision = '';
  return [
    {
      id: 'released-definitions' as const,
      run: () => journey(session, 'released-definitions', () => releasedDefinitions(session)),
    },
    {
      id: 'catalogue-browsing' as const,
      run: () =>
        journey(session, 'catalogue-browsing', async () => {
          if (!session.editor) throw new Error(session.editorCause ?? 'catalogue fixture author is unavailable');
          const type = 'schema:Book';
          const label = `Walk catalogue ${token}`;
          const fixture = await createSubject(call, session.editor, type, label);
          const searched = await searchType(call, type, 8, { expectedId: fixture.id, signal: session.signal });
          const page = requireStatus(searched, 200, `catalogue Search for ${fixture.id}`);
          const subjects = page.subjects as { id: string; type: string; labels?: Record<string, string> }[];
          const selected = subjects.find(({ id }) => id === fixture.id);
          const freshness = (page.freshness as Json | undefined)?.state;

          session.signal?.throwIfAborted();
          const publicRead = await call('GET', `/v1/subjects/${fixture.id}`, { redirect: 'manual' });
          session.signal?.throwIfAborted();
          const current = requireStatus(publicRead, 200, `anonymous catalogue Book ${fixture.id}`);
          const subject = current.subject as { type?: string; labels?: Record<string, string> };
          const revision = subjectRevision(current);
          if (
            subjectId(current) !== fixture.id ||
            revision !== fixture.revision ||
            subject.type !== type ||
            subject.labels?.en !== label
          )
            throw new Error(`Anonymous catalogue Book ${fixture.id} did not resolve to the created revision and terms`);
          if (!selected || freshness !== 'current')
            throw new Error(
              `Catalogue Search did not return Book ${fixture.id} on a current page before its deadline ` +
                `(freshness ${String(freshness)}, ${subjects.length} hits, continuation ${typeof page.next === 'string'}). ` +
                `Anonymous Subject read returned revision ${revision}.`,
            );
          if (selected.type !== type || selected.labels?.en !== label)
            throw new Error(`Catalogue Search returned incorrect type or label for Book ${fixture.id}`);
          const id = selected.id;
          const profile = await visit(session, `${stack.web}/en/catalogue/literary`, { width: 1280 });
          const reader = await visit(session, `${stack.web}${subjectHref(id, label)}`, { width: 390, theme: 'dark' });
          return { native: { id, count: subjects.length }, browser: { profile, reader } };
        }),
    },
    {
      id: 'generic-creation' as const,
      run: () =>
        journey(session, 'generic-creation', () =>
          createAndRead(session, 'schema:Book', `Walk book ${token}`, '/en/catalogue/new', true),
        ),
    },
    {
      id: 'book-and-series-editing' as const,
      run: () =>
        journey(session, 'book-and-series-editing', async () => {
          const series = await createSubject(call, session.editor, 'schema:BookSeries', `Walk series ${token}`);
          const book = await createSubject(call, session.editor, 'schema:Book', `Walk literary ${token}`);
          const proposal = await propose(call, session.editor, book.id, cited('wdt:P179', series.id));
          const browser = await visit(session, `${stack.web}/en/catalogue/literary`, { persona: 'member' });
          const reader = await visit(session, `${stack.web}${subjectHref(book.id, `Walk literary ${token}`)}`);
          return {
            native: { book: book.id, series: series.id, candidate: proposal.candidate },
            browser: { browser, reader },
          };
        }),
    },
    {
      id: 'recipe-editing' as const,
      run: () =>
        journey(session, 'recipe-editing', async () => {
          const recipe = await createSubject(call, session.editor, 'schema:Recipe', `Walk recipe ${token}`);
          const time = await propose(call, session.editor, recipe.id, citedQuantity('schema:cookTime', '+25', MINUTE));
          requireStatus(await readSubject(call, recipe.id), 200, 'recipe');
          return {
            native: { id: recipe.id, cookTime: time.candidate },
            browser: {
              create: await visit(session, `${stack.web}/en/catalogue/recipe`, { persona: 'member' }),
              reader: await visit(session, `${stack.web}${subjectHref(recipe.id, `Walk recipe ${token}`)}`),
            },
          };
        }),
    },
    {
      id: 'game-and-visual-novel-editing' as const,
      run: () =>
        journey(session, 'game-and-visual-novel-editing', async () => {
          const game = await createSubject(call, session.editor, 'schema:VideoGame', `Walk game ${token}`);
          const vn = await createSubject(call, session.editor, 'wd:Q689445', `Walk vn ${token}`);
          if (game.id === vn.id) throw new Error('game and visual novel shared an identity');
          return {
            native: { game: game.id, vn: vn.id },
            browser: await visit(session, `${stack.web}/en/catalogue/game`, { theme: 'dark', persona: 'member' }),
          };
        }),
    },
    {
      id: 'addon-editing' as const,
      run: () =>
        journey(session, 'addon-editing', async () => {
          const base = await createSubject(call, session.editor, 'schema:VideoGame', `Walk base ${token}`);
          const addon = await createSubject(call, session.editor, 'wd:Q209163', `Walk addon ${token}`);
          const link = await propose(call, session.editor, addon.id, cited('wdt:P8646', base.id));
          return {
            native: { base: base.id, addon: addon.id, candidate: link.candidate },
            browser: await visit(session, `${stack.web}/en/catalogue/addon?work=${base.id}`, { persona: 'member' }),
          };
        }),
    },
    {
      id: 'manga-editing' as const,
      run: () =>
        journey(session, 'manga-editing', () =>
          createAndRead(session, 'schema:ComicSeries', `Walk manga ${token}`, '/en/catalogue/manga'),
        ),
    },
    {
      id: 'screen-editing' as const,
      run: () =>
        journey(session, 'screen-editing', () =>
          createAndRead(session, 'schema:Movie', `Walk film ${token}`, '/en/catalogue/screen'),
        ),
    },
    {
      id: 'album-editing' as const,
      run: () =>
        journey(session, 'album-editing', () =>
          createAndRead(session, 'schema:MusicAlbum', `Walk album ${token}`, '/en/catalogue/album'),
        ),
    },
    {
      id: 'publication-editing' as const,
      run: () =>
        journey(session, 'publication-editing', async () => {
          const work = await createSubject(call, session.editor, 'schema:Book', `Walk publication work ${token}`);
          const edition = await createSubject(call, session.editor, 'bf:Instance', `Walk publication ${token}`);
          const workLink = await propose(call, session.editor, edition.id, cited('schema:exampleOfWork', work.id));
          return {
            native: { work: work.id, edition: edition.id, candidate: workLink.candidate },
            browser: await visit(session, `${stack.web}/en/catalogue/publication?work=${work.id}`, {
              persona: 'member',
            }),
          };
        }),
    },
    {
      id: 'music-context-editing' as const,
      run: () =>
        journey(session, 'music-context-editing', () =>
          createAndRead(session, 'schema:MusicVenue', `Walk venue ${token}`, '/en/catalogue/music-context'),
        ),
    },
    {
      id: 'file-and-release-group-editing' as const,
      run: () =>
        journey(session, 'file-and-release-group-editing', async () => {
          const file = await createSubject(call, session.editor, 'schema:MediaObject', `Walk file ${token}`);
          const group = await createSubject(call, session.editor, 'rezics:ReleaseGroup', `Walk group ${token}`);
          return {
            native: { file: file.id, group: group.id },
            browser: await visit(session, `${stack.web}/en/catalogue/file`, { persona: 'member' }),
          };
        }),
    },
    {
      id: 'work-part-editing' as const,
      run: () =>
        journey(session, 'work-part-editing', async () => {
          const work = await createSubject(call, session.editor, 'schema:Book', `Walk arc work ${token}`);
          const arc = await createSubject(call, session.editor, 'wd:Q2620972', `Walk arc ${token}`);
          const proposal = await propose(call, session.editor, work.id, cited('rezics:storyArc', arc.id));
          return {
            native: { work: work.id, arc: arc.id, candidate: proposal.candidate },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(work.id, `Walk arc work ${token}`, 'en', 'work-parts')}`,
              {
                persona: 'member',
              },
            ),
          };
        }),
    },
    {
      id: 'character-identity-and-credit' as const,
      run: () =>
        journey(session, 'character-identity-and-credit', async () => {
          const work = await createSubject(call, session.editor, 'wd:Q689445', `Walk character work ${token}`);
          const character = await createSubject(call, session.editor, 'wd:Q95074', `Walk character ${token}`);
          const credit = await propose(call, session.editor, work.id, cited('schema:character', character.id));
          return {
            native: { work: work.id, character: character.id, candidate: credit.candidate },
            browser: await visit(session, `${stack.web}/en/catalogue/character?work=${work.id}`, {
              persona: 'member',
            }),
          };
        }),
    },
    {
      id: 'person-and-organization-editing' as const,
      run: () =>
        journey(session, 'person-and-organization-editing', async () => {
          const person = await createSubject(call, session.editor, 'schema:Person', `Walk person ${token}`);
          const org = await createSubject(call, session.editor, 'schema:Organization', `Walk org ${token}`);
          return {
            native: { person: person.id, org: org.id },
            browser: await visit(session, `${stack.web}/en/catalogue/people`, { persona: 'member' }),
          };
        }),
    },
    {
      id: 'concept-and-scheme-editing' as const,
      run: () =>
        journey(session, 'concept-and-scheme-editing', async () => {
          const scheme = await createSubject(call, session.editor, 'skos:ConceptScheme', `Walk scheme ${token}`);
          const concept = await createSubject(call, session.editor, 'skos:Concept', `Walk concept ${token}`);
          const membership = await propose(call, session.editor, concept.id, cited('skos:inScheme', scheme.id));
          return {
            native: { scheme: scheme.id, concept: concept.id, candidate: membership.candidate },
            browser: await visit(session, `${stack.web}/en/catalogue/concept`, { persona: 'member' }),
          };
        }),
    },
    {
      id: 'multilingual-terms' as const,
      run: () =>
        journey(session, 'multilingual-terms', async () => {
          const termsBook = await createSubject(call, session.editor, 'schema:Book', `Walk terms ${token}`);
          termsBookId = termsBook.id;
          await patchTerms(call, session.editor, termsBookId, termsBook.revision, {
            labels: { en: `Walk terms renamed ${token}`, 'zh-Hant': '術語書籍' },
            descriptions: { en: 'Walk description', ja: '説明' },
          });
          const current = await readSubject(call, termsBookId);
          requireStatus(current, 200, 'terms readback');
          if ((current.body.subject as { labels: Record<string, string> }).labels['zh-Hant'] !== '術語書籍')
            throw new Error('zh-Hant label missing after terms patch');
          return {
            native: { id: termsBookId },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'terms')}`,
              { persona: 'member' },
            ),
          };
        }),
    },
    {
      id: 'cited-fact-correction' as const,
      run: () =>
        journey(session, 'cited-fact-correction', async () => {
          const proposal = await propose(call, session.editor, termsBookId, cited('schema:inLanguage', 'ja'));
          const current = await readSubject(call, termsBookId);
          requireStatus(current, 200, 'fact public read');
          return {
            native: { candidate: proposal.candidate, public: current.status },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'edit')}`,
              { persona: 'member' },
            ),
          };
        }),
    },
    {
      id: 'original-authored-text' as const,
      run: () =>
        journey(session, 'original-authored-text', async () => {
          const proposal = await propose(
            call,
            session.editor,
            termsBookId,
            citedDocument('schema:abstract', `Walk abstract ${token}`),
          );
          const publicRead = await readSubject(call, termsBookId);
          requireStatus(publicRead, 200, 'authored public');
          const selected = (publicRead.body.subject as { statements?: Record<string, { id: string }[]> }).statements?.[
            'schema:abstract'
          ];
          if (selected?.some((row) => row.id === proposal.candidate))
            throw new Error('proposal was selected as public text');
          return {
            native: { candidate: proposal.candidate, publicSelected: selected?.[0]?.id ?? null },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'authored')}`,
              { persona: 'member' },
            ),
          };
        }),
    },
    {
      id: 'relationship-correction' as const,
      run: () =>
        journey(session, 'relationship-correction', async () => {
          const author = await createSubject(call, session.editor, 'schema:Person', `Walk author ${token}`);
          const proposal = await propose(call, session.editor, termsBookId, cited('schema:author', author.id));
          return {
            native: { author: author.id, candidate: proposal.candidate },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'relations')}`,
              { persona: 'member' },
            ),
          };
        }),
    },
    {
      id: 'missing-related-work' as const,
      run: () =>
        journey(session, 'missing-related-work', async () => {
          const related = await createSubject(
            call,
            session.editor,
            'schema:BookSeries',
            `Walk missing series ${token}`,
          );
          const proposal = await propose(call, session.editor, termsBookId, cited('wdt:P179', related.id));
          requireStatus(await readSubject(call, related.id), 200, 'created related identity');
          return {
            native: { related: related.id, candidate: proposal.candidate },
            browser: await visit(session, `${stack.web}/en/catalogue/new`, { persona: 'member' }),
          };
        }),
    },
    {
      id: 'identifier-evidence' as const,
      run: () =>
        journey(session, 'identifier-evidence', async () => {
          const proposal = await propose(
            call,
            session.editor,
            termsBookId,
            cited('schema:sameAs', `https://example.test/isbn/${token}`),
          );
          const publicRead = await readSubject(call, termsBookId);
          requireStatus(publicRead, 200, 'identifier public');
          return {
            native: { candidate: proposal.candidate },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'identifiers')}`,
              { persona: 'member' },
            ),
          };
        }),
    },
    {
      id: 'why-this-value-and-history' as const,
      run: () =>
        journey(session, 'why-this-value-and-history', async () => {
          const value = await visit(
            session,
            `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'value')}`,
          );
          const changes = await visit(
            session,
            `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'changes')}`,
          );
          const sources = await visit(
            session,
            `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'sources')}`,
          );
          return { native: { id: termsBookId }, browser: { value, changes, sources } };
        }),
    },
    {
      id: 'context-creation' as const,
      run: () =>
        journey(session, 'context-creation', async () => {
          const context = await createContext(call, session.editor, `Walk Context ${token}`);
          contextId = context.id;
          const current = await call('GET', `/v1/contexts/${context.id}`, { bearer: session.editor });
          requireStatus(current, 200, 'Context read');
          return {
            native: { id: context.id, defaults: (current.body.context as Json).defaults },
            browser: await visit(session, `${stack.web}/en/my/contexts/new`, { persona: 'member' }),
          };
        }),
    },
    {
      id: 'context-editorial-decisions' as const,
      run: () =>
        journey(session, 'context-editorial-decisions', async () => {
          if (!contextId) throw new Error('Context creation did not return an id');
          const property = 'schema:inLanguage';
          const global = await propose(call, session.editor, termsBookId, cited(property, 'en'));
          await acceptCandidate(call, session.editor, termsBookId, global.candidate);
          await adoptCandidate(call, session.editor, termsBookId, global.candidate, property);
          const proposal = await propose(call, session.editor, termsBookId, cited(property, 'zh'));
          await acceptCandidate(call, session.editor, termsBookId, proposal.candidate, contextId);
          const selected = (body: Json) =>
            ((body.subject as Json).statements as Record<string, { id: string; rank: string }[]>)[property] ?? [];
          const beforeAdoption = await readSubject(call, termsBookId, session.editor, contextId);
          requireStatus(beforeAdoption, 200, 'Context reading before adoption');
          if (
            (beforeAdoption.body.subject as Json).context !== contextId ||
            !selected(beforeAdoption.body).some((row) => row.id === global.candidate) ||
            selected(beforeAdoption.body).some((row) => row.id === proposal.candidate)
          )
            throw new Error('Context acceptance changed the selected reading before adoption');
          await adoptCandidate(call, session.editor, termsBookId, proposal.candidate, property, 'preferred', contextId);
          const contextRead = await readSubject(call, termsBookId, session.editor, contextId);
          const publicRead = await readSubject(call, termsBookId);
          requireStatus(contextRead, 200, 'adopted Context language');
          requireStatus(publicRead, 200, 'independent Global language');
          if (
            (contextRead.body.subject as Json).context !== contextId ||
            selected(contextRead.body).length !== 1 ||
            !selected(contextRead.body).some((row) => row.id === proposal.candidate && row.rank === 'preferred')
          )
            throw new Error('Context adoption did not retain its exact candidate and rank');
          if (
            (publicRead.body.subject as Json).context !== PAGE_GLOBAL_CONTEXT ||
            selected(publicRead.body).length !== 1 ||
            !selected(publicRead.body).some((row) => row.id === global.candidate)
          )
            throw new Error('Context adoption changed the independent Global selection');
          return {
            native: {
              context: contextId,
              candidate: proposal.candidate,
              globalCandidate: global.candidate,
              contextRead: contextRead.status,
              globalRead: publicRead.status,
            },
            browser: await visit(
              session,
              `${stack.web}${subjectHref(termsBookId, `Walk terms renamed ${token}`, 'en', 'context-review')}?${new URLSearchParams({ context: contextId, property })}`,
              { persona: 'member' },
            ),
          };
        }),
    },
    {
      id: 'statement-consent' as const,
      run: () =>
        journey(session, 'statement-consent', async () => {
          if (session.editorAgentCause) throw new Error(session.editorAgentCause);
          const { id: target } = await session.editorAgent();
          const person = await createSubject(call, session.editor, 'schema:Person', `Walk consent identity ${token}`);
          const property = 'rezics:penNameOf';
          const proposal = await propose(call, session.editor, person.id, {
            property: { id: property },
            value: { type: 'value', content: target },
            references: [],
            qualifiers: [],
          });
          const selected = (body: Json) =>
            ((body.subject as Json).statements as Record<string, { id: string }[]>)[property]?.some(
              (row) => row.id === proposal.candidate,
            ) ?? false;
          const before = await readSubject(call, person.id);
          requireStatus(before, 200, 'private consent public read');
          if (selected(before.body)) throw new Error('private consent assertion leaked before disclosure');
          const browser = await visit(
            session,
            `${stack.web}${subjectHref(person.id, `Walk consent identity ${token}`, 'en', 'statement-consent')}?property=${encodeURIComponent(property)}&candidate=${proposal.candidate}&target=${target}`,
            { persona: 'member' },
          );
          requireStatus(
            await discloseStatement(call, session.editor, proposal.candidate),
            200,
            'disclose own private assertion',
          );
          const disclosed = await readSubject(call, person.id);
          requireStatus(disclosed, 200, 'disclosed public read');
          if (!selected(disclosed.body)) {
            const query = new URLSearchParams({ property, target });
            const current = await call('GET', `/v1/subjects/${person.id}/candidates?${query}`, {
              bearer: session.editor,
            });
            const candidates = Array.isArray(current.body.candidates) ? (current.body.candidates as Json[]) : [];
            const exact = candidates.find((row) => row.id === proposal.candidate);
            const decision = ['accepted', 'pending', 'rejected'].find((value) => value === exact?.decision);
            throw new Error(
              `disclosed assertion absent from public read; current owner candidates HTTP ${current.status}, exact decision ${decision ?? 'unavailable'}`,
            );
          }
          requireStatus(
            await retractStatement(call, session.editor, proposal.candidate),
            200,
            'retract own disclosure',
          );
          const retracted = await readSubject(call, person.id);
          requireStatus(retracted, 200, 'retracted public read');
          if (selected(retracted.body)) throw new Error('retracted assertion remained public');
          return { native: { id: person.id, target, candidate: proposal.candidate }, browser };
        }),
    },
    {
      id: 'subject-lifecycle' as const,
      run: () =>
        journey(session, 'subject-lifecycle', async () => {
          const owned = await createSubject(call, session.editor, 'schema:Book', `Walk lifecycle ${token}`);
          const proposal = await propose(call, session.editor, owned.id, cited('schema:inLanguage', 'fr'));
          await acceptCandidate(call, session.editor, owned.id, proposal.candidate);
          await adoptCandidate(call, session.editor, owned.id, proposal.candidate, 'schema:inLanguage');
          await deleteCandidate(call, session.editor, owned.id, proposal.candidate);
          const hidden = await readSubject(call, owned.id);
          requireStatus(hidden, 200, 'deleted public');
          await restoreCandidate(call, session.editor, owned.id, proposal.candidate);
          requireStatus(await readSubject(call, owned.id, session.editor), 200, 'restored owner');
          return {
            native: { id: owned.id, candidate: proposal.candidate },
            browser: await visit(session, `${stack.web}${subjectHref(owned.id, `Walk lifecycle ${token}`)}`),
          };
        }),
    },
    {
      id: 'zone-creation-and-configuration' as const,
      run: () =>
        journey(session, 'zone-creation-and-configuration', async () => {
          const zone = await createStaticZone(call, session.editor, zoneLabel, zoneHome, zoneAbout);
          zoneId = zone.id;
          zoneRevision = await saveZoneConfiguration(call, session.editor, zone.id, zone.revision, zone.configuration);
          const preview = await call('GET', `/v1/zones/${zone.id}/configuration`, { bearer: session.editor });
          requireStatus(preview, 200, 'saved configuration');
          return {
            native: { id: zone.id, revision: zoneRevision },
            browser: {
              create: await visit(session, `${stack.web}/en/my/zones/new`, { persona: 'member' }),
              edit: await visit(session, `${stack.web}/en/my/zones/${zone.id}/edit`, { persona: 'member' }),
            },
          };
        }),
    },
    {
      id: 'zone-publication-and-navigation' as const,
      run: () =>
        journey(session, 'zone-publication-and-navigation', async () => {
          if (!zoneId) throw new Error('Zone creation did not return an id');
          zoneRevision = await publishZone(call, session.editor, zoneId, zoneRevision);
          const home = await readZonePage(call, zoneId, '');
          requireStatus(home, 200, 'anonymous zone home');
          const about = await readZonePage(call, zoneId, 'about');
          requireStatus(about, 200, 'anonymous zone about');
          const homePage = await visit(session, `${stack.web}/en/zones/${zoneId}`, { width: 1280 });
          const aboutPage = await visit(session, `${stack.web}/en/zones/${zoneId}/about`, {
            width: 390,
            theme: 'dark',
          });
          const jaHome = await visit(session, `${stack.web}/ja/zones/${zoneId}`);
          return {
            native: { id: zoneId, home: home.status, about: about.status },
            browser: { homePage, aboutPage, jaHome },
          };
        }),
    },
    {
      id: 'zone-lifecycle-and-moderation' as const,
      run: () =>
        journey(session, 'zone-lifecycle-and-moderation', async () => {
          if (!zoneId) throw new Error('Zone creation did not return an id');
          const deleted = await deleteZone(call, session.editor, zoneId, zoneRevision);
          requireStatus(deleted, 200, 'delete Zone');
          const missing = await readZonePage(call, zoneId, '');
          if (missing.status !== 404) throw new Error(`deleted Zone read HTTP ${missing.status}`);
          const unavailable = await visit(session, `${stack.web}/en/zones/${zoneId}`, { expectedStatus: 404 });
          const restored = await restoreZone(
            call,
            session.editor,
            zoneId,
            String((deleted.body.zone as { revision: string }).revision),
          );
          requireStatus(restored, 200, 'restore Zone');
          requireStatus(await readZonePage(call, zoneId, ''), 200, 'restored anonymous home');
          const withheld = await takedownZone(
            call,
            session.editor,
            zoneId,
            String((restored.body.zone as { revision: string }).revision),
            '/labels/en',
          );
          requireStatus(withheld, 200, 'Zone pointer takedown');
          return {
            native: { delete: deleted.status, restore: restored.status, takedown: withheld.status },
            browser: { unavailable, restored: await visit(session, `${stack.web}/en/zones/${zoneId}`) },
          };
        }),
    },
  ];
}
