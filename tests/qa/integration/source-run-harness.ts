import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { SourceIntakeStore, SourceProviderRateLimited } from '../../../services/main/src/modules/source/intake.ts';
import { OpenLibraryConversionStore } from '../../../services/main/src/modules/source/open-library-conversion.ts';

type Json = Record<string, unknown>;

/** A controlled Open Library origin. Tests mutate it between and during runs. */
export class FixtureOpenLibrary {
  readonly requests: string[] = [];
  readonly goProxyRequests: string[] = [];
  readonly works = new Map<string, Json>();
  readonly editions = new Map<string, Json[]>();
  readonly ratings = new Map<string, Json>();
  /** Newest first, as the provider lists recent changes. */
  changes: Array<{ id: number; key: string; revision: number; changes: string }> = [];
  readonly overrides = new Map<string, () => Response>();
  readonly goProxyOverrides = new Map<string, () => Response>();
  readonly goProxyResponses = new Map<string, Uint8Array>();
  afterRequest: ((path: string) => void) | null = null;

  readonly fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://openlibrary.org/') && init.redirect === 'manual') {
      const path = url.slice('https://openlibrary.org'.length);
      this.requests.push(path);
      try { return this.respond(path); } finally { this.afterRequest?.(path); }
    }
    if (url.startsWith('https://proxy.golang.org/') && init.redirect === 'error') {
      const path = new URL(url).pathname.slice(1);
      this.goProxyRequests.push(path);
      const override = this.goProxyOverrides.get(path);
      if (override) return override();
      const bytes = this.goProxyResponses.get(path);
      return bytes ? new Response(new Uint8Array(bytes), { headers: { 'content-type': 'text/plain' } })
        : new Response('missing', { status: 404 });
    }
    throw new Error('run fetch escaped its fixed provider origins');
  }) as typeof fetch;

  private respond(path: string): Response {
    const override = this.overrides.get(path);
    if (override) return override();
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    let match = /^\/works\/(OL[0-9]+W)\.json$/.exec(path);
    if (match) return this.works.has(match[1]!) ? json(this.works.get(match[1]!)) : new Response('missing', { status: 404 });
    match = /^\/works\/(OL[0-9]+W)\/editions\.json\?limit=([0-9]+)&offset=([0-9]+)$/.exec(path);
    if (match) {
      const all = this.editions.get(match[1]!) ?? [];
      const offset = Number(match[3]);
      return json({ links: {}, size: all.length, entries: all.slice(offset, offset + Number(match[2])) });
    }
    match = /^\/works\/(OL[0-9]+W)\/ratings\.json$/.exec(path);
    if (match) return json(this.ratings.get(match[1]!) ?? { summary: { average: null, count: 0 }, counts: {} });
    match = /^\/recentchanges\.json\?limit=([0-9]+)(?:&offset=([0-9]+))?$/.exec(path);
    if (match) {
      const limit = Number(match[1]);
      const offset = Number(match[2] ?? 0);
      return json(this.changes.slice(offset, offset + limit));
    }
    return new Response('unknown', { status: 404 });
  }

  work(id: string, revision: number, extra: Json = {}): void {
    this.works.set(id, { key: `/works/${id}`, title: `Fixture ${id}`, type: { key: '/type/work' },
      revision, subjects: ['Foxes'], ...extra });
  }

  /** Append provider changes with the next ids; the newest stays first. */
  addChanges(count: number): void {
    let next = this.changes.length ? this.changes[0]!.id + 1 : 1;
    for (let index = 0; index < count; index++, next++) {
      // The live provider shape: one entry per key, numeric changeset id, `changes` as a JSON string.
      this.changes.unshift({ id: next, key: `/works/OL${next}W`, revision: 1,
        changes: JSON.stringify([{ key: `/works/OL${next}W`, revision: 1 }]) });
    }
  }
}

export interface RunHarness {
  provider: FixtureOpenLibrary;
  contentPool: Pool;
  accessPool: Pool;
  ownerId: string;
  gate: { reserved: number; failAt: number | null };
  post: (path: string, token: string, body: unknown, key?: string) => Promise<Response>;
  get: (path: string, token: string) => Promise<Response>;
  close: () => Promise<void>;
}

export async function runHarness(): Promise<RunHarness> {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  await migrateContent(contentPool);
  const issuer = `https://qa-source-run-${randomUUID()}.test`;
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const ownerId = randomUUID();
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $2, $3), ($4, $2, $5)`, [ownerId, issuer, owner.subject, randomUUID(), other.subject]);
  const account = { verify: async (request: Request, required: readonly string[]) => {
    const token = request.headers.get('authorization');
    if (token === 'Bearer owner') return owner;
    if (token === 'Bearer reader' && required[0] === 'source:read') return owner;
    if (token === 'Bearer other') return other;
    throw new AccountAssertionDenied('scope is unavailable');
  } };
  const provider = new FixtureOpenLibrary();
  const gate = { reserved: 0, failAt: null as number | null };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/source-run-unused' },
    account, access: new AccessAdmissionRegistry(accessPool),
    sourceIntake: new SourceIntakeStore(contentPool),
    sourceConversions: new OpenLibraryConversionStore(contentPool, new SourceIntakeStore(contentPool)),
    sourceAcquisitions: sourceAcquisitionServices(contentPool, { fetcher: provider.fetch, reserve: async () => {
      // The shared provider gate is qualified by its own fixture; this one counts and can
      // interrupt a run exactly like a full rate queue does.
      if (gate.failAt !== null && gate.reserved >= gate.failAt) throw new SourceProviderRateLimited('queue is full');
      gate.reserved++;
    } }),
  });
  const headers = (token: string, key?: string) => ({ authorization: `Bearer ${token}`,
    'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) });
  return {
    provider, contentPool, accessPool, ownerId, gate,
    post: (path, token, body, key) => app.handle(new Request(`http://main.local${path}`,
      { method: 'POST', headers: headers(token, key), body: JSON.stringify(body) })),
    get: (path, token) => app.handle(new Request(`http://main.local${path}`, { headers: headers(token) })),
    close: async () => { await Promise.all([contentPool.end(), accessPool.end()]); },
  };
}

export const idOf = (uri: string) => uri.split('/').at(-1)!;
