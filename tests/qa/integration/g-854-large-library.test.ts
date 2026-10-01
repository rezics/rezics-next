import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { LibraryBundleExporter } from '../../../services/main/src/modules/library-export/bundle.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { GRAPHS,iri,lit } from '../../../services/main/src/modules/work/activate.ts';
import type { CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';
const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G-854: 1,200 distinct Works export beyond every bound and re-import through Main with every status date intact',async () => {
  const began = Date.now(),home = await startHomeStack('g-854-large-library');
  try {
    const { stack } = home;
    const a = await home.provision('Large library owner',home.reader.token),b = await home.provision('Large library recipient',home.author.token);
    const imports = new ReaderLibraryImportStore(stack.contentPool),files = new LibraryFileStore(stack.contentPool);
    const app = createMainApp(stack.fuseki,{ ...home.deps,libraryImport: imports,libraryFiles: files,
      libraryBundle: new LibraryBundleExporter(stack.contentPool,stack.accessPool),libraryRatings: new ReaderLibraryRatings(stack.accessPool) });
    imports.setDispatch(request => app.handle(request));
    const call = async <T>(method: string,path: string,body?: object,token = home.reader.token) => {
      const response = await app.handle(new Request(`http://main.local${path}`,{ method,headers: { authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),...(body ? { 'content-type': 'application/json' } : {}) },...(body ? { body: JSON.stringify(body) } : {}) }));
      if (![200,201,202].includes(response.status)) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    // Same large owner fixture pattern as G-824: publication pointer shape is
    // faithful to the catalogue reads; reader writes below use the real API.
    const works = Array.from({ length: 1200 },id);
    for (let offset=0;offset<works.length;offset+=50) {
      const batch = works.slice(offset,offset+50).map((work,i) => ({ work,main: id(),head: id(),mainHead: id(),
        contribution: id(),decision: id(),draft: id(),selection: id(),title: `Portable title ${offset+i}` }));
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${batch.map(f => `${iri(f.work)} a schema:CreativeWork ; rv:head ${iri(f.head)} ; rv:mainVersion ${iri(f.main)} ; rdfs:label ${lit(f.title)}@en .
          ${iri(f.main)} a rv:MainVersion ; rv:work ${iri(f.work)} ; rv:head ${iri(f.mainHead)} ; rv:selectionHead ${iri(f.selection)} .
          ${iri(f.contribution)} rv:work ${iri(f.work)} ; rv:publicationHead ${iri(f.decision)} .`).join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${batch.map(f => `${iri(f.selection)} a rv:PublicationSelection ; rv:language "en" ; rv:work ${iri(f.work)} ; rv:mainVersion ${iri(f.main)} ;
          rv:contribution ${iri(f.contribution)} ; rv:publicationDecision ${iri(f.decision)} ; rv:selectedDraft ${iri(f.draft)} .
          ${iri(f.decision)} a rv:PublicationDecision ; rv:component ${iri(f.contribution)} ; rv:work ${iri(f.work)} ; rv:contribution ${iri(f.contribution)} ;
          rv:disclosure rv:Public ; rv:language "en" ; rv:selectedDraft ${iri(f.draft)} .
          ${iri(f.draft)} a rv:RevisionAnchor ; rv:component ${iri(f.contribution)} .`).join('\n')} } }`);
    }
    await stack.contentPool.query(`INSERT INTO reader.library_status(agent,work,status,started_on,version)
      SELECT $1,work,'want-to-read','2026-09-01'::date,1 FROM unnest($2::text[]) AS work`,[a,works]);
    expect(Date.now()-began).toBeLessThan(600_000);
    type Page = { rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
    const all: CanonicalRow[] = []; let cursor: string | null = null,snapshot: string | undefined;
    do {
      const query = new URLSearchParams({ actingSubject: a,limit: '20',...(cursor ? { cursor } : {}),...(snapshot ? { snapshot } : {}) });
      const page = await call<Page>('GET',`/v1/me/library-export?${query}`);
      if (cursor) expect((await call<Page>('GET',`/v1/me/library-export?${query}`)).rows).toEqual(page.rows);
      snapshot ??= page.snapshot;all.push(...page.rows);cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(1200);expect(new Set(all.map(r => r.work)).size).toBe(1200);
    const uploaded = await call<{ id: string }>('POST','/v1/me/library-imports',{ actingSubject: b,format: 'rezics',
      file: JSON.stringify({ profile: 'rezics-library-export-v1',rows: all }) },home.author.token);
    let index = -1;
    do {
      const page = await call<{ nextCursor: number | null }>('GET',`/v1/me/library-imports/${uploaded.id}/rows?actingSubject=${encodeURIComponent(b)}&cursor=${index}`,undefined,home.author.token);
      index = page.nextCursor ?? -1;
    } while (index !== -1);
    let progress: { pending: boolean; issues: number };
    do { progress = await call('POST',`/v1/me/library-imports/${uploaded.id}/apply`,{ actingSubject: b,context: null,language: 'en' },home.author.token); } while (progress.pending);
    expect(progress.issues).toBe(0);
    const states = async (agent: string) => (await stack.contentPool.query(`SELECT work,status,started_on::text,finished_on::text
      FROM reader.library_status WHERE agent=$1 ORDER BY work`,[agent])).rows;
    expect(await states(b)).toEqual(await states(a));
    const plan = (await stack.contentPool.query(`EXPLAIN (ANALYZE,FORMAT JSON) SELECT work FROM reader.library_status WHERE agent=$1 AND work>$2 ORDER BY work LIMIT 21`,[a,''])).rows[0]['QUERY PLAN'][0].Plan;
    expect(JSON.stringify(plan)).toContain('Index');
    expect((await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.consumption_session WHERE agent=$1',[b])).rows[0].n).toBe(0);
  } finally { await home.stop(); }
},480_000);
