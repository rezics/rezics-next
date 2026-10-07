import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { LibraryCopyStore, type CopyState } from '../../../services/main/src/modules/library/copies.ts';
import { LibraryLoanStore, type LoanView } from '../../../services/main/src/modules/library/loans.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { LibraryFileStore, importDigest, type StoredSourceRow } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { emptyRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { ReadingSettingsStore } from '../../../services/main/src/modules/reading-settings/store.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import type { SessionState } from '../../../services/main/src/modules/session/contract.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startHomeStack } from './feed-read-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

test('library consent fences personal owners while read consent retains every reading API', async () => {
  const home = await startHomeStack('library-write-scope');
  let accountServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    const { stack } = home;
    const agent = await home.provision('Library consent reader', home.reader.token);
    await json(await home.call('PUT', `/v1/agents/${agent.slice(-36)}/library-visibility`,
      { visibility: 'public', expectedVersion: 0 }, home.reader.token));
    const editor = await stack.member('edition-editor');
    const work = await stack.publicWork(editor.actor, ['en'], 'Library consent book');
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    await editor.grant(`work:read:${work.work}`, 'work.read');
    const release = `https://rezics.com/id/${randomUUID()}`;
    await json(await editor.send('PUT', `/v1/works/${work.work.slice(-36)}/releases/${release.slice(-36)}`, {
      profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: release,
      kind: 'formal', status: 'official', contentLanguages: ['en'], isTranslation: false,
      originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
      title: { value: 'Library consent edition', language: 'en' }, editionStatement: null,
      publisher: null, publicationYear: null, isbn13: null, originalUrl: null,
      fixedRelease: null, coverage: null, evidence: null,
    }));
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work.work)} a <https://schema.org/Book> } }`);
    const chapter = await stack.publicWork(editor.actor, ['en'], 'Library consent chapter');
    await editor.grant(`work:read:${chapter.work}`, 'work.read');
    const fixtureApp = createMainApp(stack.fuseki, { ...home.deps, account: {
      verify: async request => request.headers.get('authorization') === `Bearer ${editor.token}`
        ? { ...editor.principal, emailVerified: true }
        : home.deps.account.verify(request),
    } });
    const fixtureWrite = (path: string, body: object) => fixtureApp.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${editor.token}`,
        'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body),
    }));
    const composition = await json<{ structure: string; revision: string }>(await fixtureWrite('/v1/compositions', {
      profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: editor.actor,
    }), 201);
    const inserted = await json<{ occurrences: string[] }>(await fixtureWrite(
      `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
        profile: 'book-composition', expectedHead: composition.revision, actingSubject: editor.actor,
        operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'chapter',
          target: chapter.work, label: { value: 'Library consent chapter', language: 'en' } }],
      }));
    const occurrence = inserted.occurrences[0]!;
    // Public native chapter Work text uses the catalogue contribution profile.
    // Its explicit Access read grant lets the progress API inspect that target.
    const chapterScope = `work:read:${chapter.work}`;
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [chapterScope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`, [randomUUID(), home.reader.principalId, agent]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour')`, [randomUUID(), agent, chapterScope]);

    // Real JWT verification and authoritative introspection distinguish two
    // consents for the same principal, including a later consent downgrade.
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'library-consent', alg: 'RS256', use: 'sig' };
    const principal = home.reader.principal;
    const audience = 'http://main.local';
    const current = new Map<string, string[]>();
    const issue = async (scopes: string[]) => {
      const token = await new SignJWT({ scope: scopes.join(' '), jti: randomUUID() })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(principal.issuer).setSubject(principal.subject).setAudience(audience)
        .setIssuedAt().setExpirationTime('5m').sign(privateKey);
      current.set(token, scopes);
      return token;
    };
    const readToken = await issue(['work:read']);
    const writeToken = await issue(['work:read', 'library:write']);
    accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/jwks') return Response.json({ keys: [jwk] });
      const form = new URLSearchParams(await request.text());
      if (form.get('client_id') !== 'library-main' || form.get('client_secret') !== 'library-secret') {
        return new Response('unauthorized', { status: 401 });
      }
      const scopes = current.get(form.get('token') ?? '');
      return Response.json(scopes ? { active: true, iss: principal.issuer, sub: principal.subject,
        aud: audience, scope: scopes.join(' '), email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 300 } : { active: false });
    } });
    const accountBase = `http://127.0.0.1:${accountServer.port}`;
    const account = new AccountAssertionVerifier({ issuer: principal.issuer, audience,
      jwksUrl: `${accountBase}/jwks`, introspectUrl: `${accountBase}/introspect`,
      clientId: 'library-main', clientSecret: 'library-secret' });

    let ownerStatements = 0;
    const countedPool = new Proxy(stack.contentPool, { get(pool, key) {
      if (key === 'query') return (...args: unknown[]) => {
        ownerStatements++;
        return Reflect.apply(pool.query, pool, args);
      };
      if (key === 'connect') return async () => new Proxy(await pool.connect(), { get(client, field) {
        if (field === 'query') return (...args: unknown[]) => {
          ownerStatements++;
          return Reflect.apply(client.query, client, args);
        };
        const value = Reflect.get(client, field);
        return typeof value === 'function' ? value.bind(client) : value;
      } });
      const value = Reflect.get(pool, key);
      return typeof value === 'function' ? value.bind(pool) : value;
    } }) as Pool;
    const library = new ReaderLibraryStatusStore(countedPool);
    const files = new LibraryFileStore(countedPool);
    const imports = new ReaderLibraryImportStore(countedPool);
    const app = createMainApp(stack.fuseki, { ...home.deps, account, libraryStatus: library,
      libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      libraryCopies: new LibraryCopyStore(countedPool), libraryLoans: new LibraryLoanStore(countedPool),
      libraryFiles: files, libraryImport: imports,
      sessions: new ConsumptionSessionStore(countedPool, library),
      progress: new StructureProgressStore(countedPool),
      readingSettings: new ReadingSettingsStore(countedPool) });
    imports.setDispatch(request => app.handle(request));
    const call = (method: string, path: string, body?: object, token = readToken, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        authorization: `Bearer ${token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const tableNames = (await stack.contentPool.query<{ schemaname: string; tablename: string }>(
      `SELECT schemaname,tablename FROM pg_tables WHERE schemaname='reader'
        OR (schemaname='structure' AND tablename IN ('progress','progress_command'))
        ORDER BY schemaname,tablename`)).rows;
    const snapshotSql = tableNames.map(({ schemaname, tablename }) => {
      if (!/^[a-z_]+$/.test(schemaname) || !/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected personal table name');
      return `SELECT '${schemaname}.${tablename}' AS name, coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS rows FROM ${schemaname}.${tablename} r`;
    }).join(' UNION ALL ');
    const snapshot = async () => (await stack.contentPool.query(snapshotSql)).rows;
    const denied = async (method: string, path: string, body?: object, token = readToken, key = randomUUID()) => {
      const before = await snapshot();
      const statements = ownerStatements;
      expect(await json(await call(method, path, body, token, key), 401))
        .toMatchObject({ code: 'account_assertion_denied' });
      expect(ownerStatements).toBe(statements);
      expect(await snapshot()).toEqual(before);
    };
    const write = async <T>(method: string, path: string, body: object | undefined, status = 200) => {
      const key = randomUUID();
      await denied(method, path, body, readToken, key);
      return json<T>(await call(method, path, body, writeToken, key), status);
    };
    const own = { actingSubject: agent };
    const encoded = encodeURIComponent(agent);
    const workPath = `/v1/works/${work.work.slice(-36)}`;

    const copy = await write<CopyState>('POST', '/v1/me/library-copies', {
      ...own, expectedVersion: 0, release, format: 'paperback',
    }, 201);
    expect(copy).toMatchObject({ work: work.work, release, version: 1 });
    const copyPath = `/v1/me/library-copies/${copy.id.slice(-36)}`;
    expect(await write('PATCH', copyPath, { ...own, expectedVersion: 1, format: 'hardcover' }))
      .toMatchObject({ version: 2, format: 'hardcover' });
    const loan = await write<LoanView>('POST', '/v1/me/library-loans', {
      ...own, expectedVersion: 0, copy: copy.id, direction: 'lent',
      counterparty: { kind: 'name', name: 'Library consent borrower' },
      startedAt: '2026-01-01T00:00:00Z', dueAt: '2026-01-10T00:00:00Z',
    }, 201);
    const loanPath = `/v1/me/library-loans/${loan.id.slice(-36)}`;
    expect(await write('POST', `${loanPath}/extend`, {
      ...own, expectedVersion: 1, dueAt: '2026-01-20T00:00:00Z',
    })).toMatchObject({ version: 2 });
    expect(await write('POST', `${loanPath}/return`, { ...own, expectedVersion: 2 }))
      .toMatchObject({ version: 3, state: 'returned' });

    expect(await write('PUT', `${workPath}/reader-status`, {
      ...own, expectedVersion: 0, status: 'read', finishedOn: '2026-01-01',
    })).toMatchObject({ version: 1, status: 'read' });
    const progressPath = `/v1/compositions/${composition.structure.slice(-36)}/occurrences/${occurrence.slice(-36)}/progress`;
    const progressBody = { ...own, expectedVersion: 0, completed: false, position: 'paragraph-4' };
    const lastReadBefore = (await stack.contentPool.query(
      'SELECT last_read_at FROM reader.library_status WHERE agent=$1 AND work=$2', [agent, work.work])).rows[0];
    expect(await write('PUT', progressPath, progressBody))
      .toMatchObject({ structure: composition.structure, occurrence, version: 1, position: 'paragraph-4' });
    const lastReadAfter = (await stack.contentPool.query(
      'SELECT last_read_at FROM reader.library_status WHERE agent=$1 AND work=$2', [agent, work.work])).rows[0];
    expect(lastReadAfter.last_read_at).not.toBeNull();
    expect(lastReadAfter).not.toEqual(lastReadBefore);
    expect(await json(await call('GET', `${progressPath}?actingSubject=${encoded}`)))
      .toMatchObject({ version: 1, completed: false, position: 'paragraph-4' });
    expect(await write('PUT', `/v1/me/import-reviews/${work.work.slice(-36)}`, {
      ...own, expectedVersion: 0, text: 'Private consent-protected review', language: 'en', spoiler: false,
    })).toMatchObject({ version: 1, text: 'Private consent-protected review' });
    expect(await write('PUT', '/v1/me/reading-goal', { ...own, expectedVersion: 0, year: 2026, target: 12 }))
      .toMatchObject({ version: 1, target: 12 });
    const session = await write<SessionState>('POST', '/v1/me/sessions', {
      ...own, expectedVersion: 0, target: work.work, state: 'active',
    }, 201);
    expect(session).toMatchObject({ version: 1, state: 'active' });
    const sessionPath = `/v1/me/sessions/${session.id.slice(-36)}`;
    expect(await write('PATCH', sessionPath, { ...own, expectedVersion: 1, state: 'paused' }))
      .toMatchObject({ version: 2, state: 'paused' });
    const settings = { ...own, expectedVersion: 0, fontSize: 22, lineWidth: 'wide',
      typeface: 'sans', paragraphIndent: true, theme: 'dark', cjkSpacing: 'none', cjkPunctuation: 'strict' };
    expect(await write('PUT', '/v1/reader/settings', settings)).toMatchObject({ version: 1, fontSize: 22 });

    const upload = await write<{ id: string }>('POST', '/v1/me/library-imports', {
      ...own, format: 'generic-csv', file: 'Title,Note\nPrivate import evidence,Personal note',
      mapping: { title: 'Title', statuses: {} },
    }, 201);
    const importPath = `/v1/me/library-imports/${upload.id}`;
    expect(await write('PUT', `${importPath}/rows/0`, { ...own, expectedVersion: 1, choice: 'private' }))
      .toMatchObject({ resolved: true });
    expect(await write('POST', `${importPath}/apply`, { ...own, context: null, language: 'en' }))
      .toMatchObject({ completed: 1, issues: 0, pending: false });
    await denied('POST', `${importPath}/rows/0/adoptions`, { ...own, workId: 'OL45804W' });

    // An unmatched retained row gets its read view without persisting a match
    // or increasing its review version under read-only consent.
    const viewRow = { ...emptyRow(`scope-view:${randomUUID()}`, 'Private retained evidence', {}), kind: 'retained' as const };
    const viewFile = await files.create(agent, randomUUID(), importDigest([viewRow]), 'rezics', [viewRow]);
    const rowsPath = `/v1/me/library-imports/${viewFile.id}/rows?actingSubject=${encoded}`;
    const storedBefore = await files.page(agent, viewFile.id, -1);
    const viewed = await json<{ rows: StoredSourceRow[] }>(await call('GET', rowsPath));
    expect(viewed.rows[0]).toMatchObject({ version: 1, match: { kind: 'matched' } });
    expect(await files.page(agent, viewFile.id, -1)).toEqual(storedBefore);
    expect(storedBefore.rows[0]?.match).toBeNull();

    const reads = [
      `${workPath}/copies?actingSubject=${encoded}`,
      `/v1/me/library-loans?actingSubject=${encoded}`,
      `${workPath}/reader-state?actingSubject=${encoded}`,
      `/v1/me/work-states?actingSubject=${encoded}&works=${encodeURIComponent(work.work)}`,
      `/v1/me/shelves?actingSubject=${encoded}`,
      `/v1/me/shelves/status/reading/works?actingSubject=${encoded}`,
      `/v1/agents/${agent.slice(-36)}/shelves?actingSubject=${encoded}`,
      `/v1/agents/${agent.slice(-36)}/shelves/status/reading/works?actingSubject=${encoded}`,
      `/v1/me/import-reviews?actingSubject=${encoded}&works=${encodeURIComponent(work.work)}`,
      `/v1/me/reading-stats?actingSubject=${encoded}&year=2026`,
      `/v1/me/reading-goal?actingSubject=${encoded}&year=2026`,
      rowsPath,
      `/v1/me/sessions?actingSubject=${encoded}`,
      `/v1/reader/settings?actingSubject=${encoded}`,
      `${progressPath}?actingSubject=${encoded}`,
    ];
    for (const path of reads) {
      const response = await call('GET', path);
      expect(response.status, path).toBe(200);
      await json(response);
    }
    expect(await json(await call('GET', `/v1/reader/settings?actingSubject=${encoded}`)))
      .toMatchObject({ version: 1, fontSize: 22 });

    // The same signed JWT loses mutation rights when current consent changes;
    // neither fresh writes nor exact retries can spend the old consent.
    const replayBody = { ...own, expectedVersion: 1, year: 2026, target: 24 };
    const replayKey = randomUUID();
    await json(await call('PUT', '/v1/me/reading-goal', replayBody, writeToken, replayKey));
    current.set(writeToken, ['work:read']);
    await denied('PUT', '/v1/me/reading-goal', replayBody, writeToken, replayKey);
    await denied('PUT', '/v1/reader/settings', { ...settings, expectedVersion: 1 }, writeToken);
    await denied('PUT', progressPath, { ...progressBody, expectedVersion: 1, position: 'paragraph-8' }, writeToken);
    expect(await json(await call('GET', `/v1/me/reading-goal?actingSubject=${encoded}&year=2026`, undefined, writeToken)))
      .toMatchObject({ version: 2, target: 24 });
    current.set(writeToken, ['work:read', 'library:write']);
    expect(await json(await call('PUT', '/v1/me/reading-goal', replayBody, writeToken, replayKey)))
      .toMatchObject({ version: 2, replayed: true });
    expect(await write('DELETE', copyPath, { ...own, expectedVersion: 2 })).toMatchObject({ removed: true });
    expect(await write('DELETE', `${importPath}?actingSubject=${encoded}`, undefined))
      .toMatchObject({ deleted: true });
  } finally {
    await accountServer?.stop(true);
    await home.stop();
  }
}, 600_000);
