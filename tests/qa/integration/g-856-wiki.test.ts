import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { parseFile } from '../../../packages/wiki-toolkit/src/index.ts';
import { prideExample } from '../../../packages/wiki-toolkit/skill/examples/pride.ts';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';
import { seedWiki } from '../../../apps/web/tests/g-849-records.ts';
import { startMediaStack } from './media-support.ts';
import { wikiDeltaJourney } from './g-693-wiki-journey.ts';

const short = (id: string) => id.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;
const fixture = (edition: number) => {
  const lock = JSON.parse(readFileSync('tests/fixtures/fixtures.lock.json', 'utf8')) as {
    entries: { id: string; seed: string }[];
  };
  const entry = lock.entries.find((row) => row.id === `pg${edition}`)!;
  return Buffer.from((JSON.parse(readFileSync(entry.seed, 'utf8')) as { text: string }).text);
};

// Follow the installed skill: convert locally, verify exact passages, discover
// names over MCP, validate, propose, review and apply. No model or uploaded book.
test('G856: English and Finnish Pride editions extract the same character through MCP and a later bundle preserves earlier claims', async () => {
  const f = await startMediaStack('g856-wiki', { agents: true, rights: true, library: true });
  try {
    const seed = await seedWiki(f, null);
    const steward = await f.member('g856-steward');
    seed.tokens.set(steward.token, steward.principal);
    await f.accessPool.query(
      `INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity')`,
      [randomUUID(), steward.principalId, steward.actor],
    );
    for (const [scope, action] of [
      [`work:read:${seed.work}`, 'work.read'],
      [`work:edit:${seed.work}`, 'work.edit'],
      [`work:review:${seed.work}`, 'work.review'],
      ['semantic:create:root', 'semantic.change'],
      [`statement:speak:${steward.actor}`, 'statement.record'],
    ] as const)
      await steward.grant(scope, action);
    for (const segment of ['franchise', 'characters', 'places', 'events', 'chapters']) {
      const response = await seed.read(
        `/v1/zones/${short(seed.zone)}/routes?path=%2F${segment}&position=all`,
      );
      expect(response.status).toBe(200);
      const route = (await response.json()) as { mount: { target: string } };
      await steward.grant(`collection:edit:${route.mount.target}`, 'collection.edit');
    }
    const objects = f.objects('semantic/structure/');
    await objects.initialize();
    const deps: MainWorkDependencies = {
      environment: f.env,
      access: f.access,
      account: {
        verify: async (request) => {
          const principal = seed.tokens.get(
            request.headers.get('authorization')?.replace('Bearer ', '') ?? '',
          );
          if (!principal) throw new Error('QA bearer missing');
          return principal;
        },
      },
      structureObjects: objects,
      editorialReview: new EditorialReviewStore(f.accessPool),
      wikiEvidence: new WikiEvidenceStore(f.contentPool),
      wikiQuotations: new WikiQuotationStore(f.contentPool),
      readingPositions: new ReadingPositionStore(f.contentPool),
      media: f.media,
      mediaAccess: f.mediaAccess,
      rights: { store: new RightsStore(f.contentPool, f.accessPool) },
      mcp: { issuer: 'https://account.test/api/auth', resource: 'http://main.local' },
    };
    const app = createMainApp(f.fuseki, deps);
    const call = (
      method: string,
      path: string,
      body?: object,
      token = seed.holderToken,
      key = randomUUID(),
    ) =>
      app.handle(
        new Request(
          `http://main.local${path}${method === 'GET' && !path.includes('actingSubject=') ? `${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(seed.holderActor)}` : ''}`,
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              'idempotency-key': key,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        ),
      );
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const text = await response.text();
      if (response.status !== status) throw new Error(`${response.status}: ${text}`);
      return JSON.parse(text) as T;
    };
    const mcp = async <T>(name: string, body: object): Promise<T> => {
      const envelope = await json<{ result: { structuredContent: { status: number; body: T } } }>(
        await app.handle(
          new Request('http://main.local/mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${seed.holderToken}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2026-07-28',
              'mcp-method': 'tools/call',
              'mcp-name': name,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name,
                arguments: { body },
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientInfo': { name: 'g856', version: '1' },
                  'io.modelcontextprotocol/clientCapabilities': {},
                },
              },
            }),
          }),
        ),
      );
      if (envelope.result.structuredContent.status !== 200)
        throw new Error(`${name}: ${JSON.stringify(envelope.result.structuredContent)}`);
      return envelope.result.structuredContent.body;
    };
    const actor = seed.holderActor;
    const predicate = await json<{ component: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: actor,
        state: { component: 'definition', kind: 'property' },
      }),
      201,
    );
    await steward.grant(`semantic:read:${predicate.component}`, 'semantic.read');
    await f.accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`semantic:read:${predicate.component}`],
    );
    await f.accessPool.query(
      `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$2,$3,'semantic.read',now() + interval '8 hours')`,
      [randomUUID(), actor, `semantic:read:${predicate.component}`],
    );
    const ids = {
      target: seed.work,
      zone: seed.zone,
      continuity: seed.work,
      occurrence: seed.chapters[0]!,
      predicate: predicate.component,
    };
    const english = prideExample(fixture(1342), ids);
    expect(parseFile(fixture(1342), 'txt').units.length).toBeGreaterThanOrEqual(61);
    expect(
      await mcp('wiki_candidates', {
        actingSubject: actor,
        target: seed.work,
        zone: seed.zone,
        names: english.entities[0]!.names.map(({ value, language }) => ({ value, language })),
      }),
    ).toMatchObject({ items: [{ status: 'new' }] });
    expect(await mcp('wiki_validate', { actingSubject: actor, bundle: english })).toMatchObject({
      status: 'acceptable',
    });
    const apply = async (bundle: WikiExtraction) => {
      const header = await json<{ revision: string }>(
        await call(
          'GET',
          `/v1/works/${short(seed.work)}?actingSubject=${encodeURIComponent(actor)}`,
        ),
      );
      const submitted = await submitWikiBundle(
        {
          send: async (request) => {
            const response = await app.handle(
              new Request(`http://main.local${request.path}`, {
                method: request.method,
                headers: request.headers,
                body: JSON.stringify(request.body),
              }),
            );
            return { status: response.status, body: await response.json() };
          },
        },
        {
          target: {
            resource: seed.work,
            revision: header.revision,
            context: 'urn:rezics:context:global',
          },
          bundle,
          baseHeads: [{ component: seed.work, head: header.revision }],
          evidence: [],
          actingSubject: actor,
        },
        `Bearer ${seed.holderToken}`,
        randomUUID(),
      );
      expect(submitted.status).toBe(201);
      const proposal = submitted.body as { proposal: string };
      const key = randomUUID();
      for (let attempt = 0; attempt < 40; attempt++) {
        const response = await call(
          'POST',
          `/v1/editorial/proposals/${proposal.proposal}/decisions`,
          {
            profile: 'editorial-proposal-decide-v1',
            revision: 1,
            outcome: 'applied',
            approve: true,
            message: 'Verified the exact local passage and alignment',
            actingSubject: steward.actor,
          },
          steward.token,
          key,
        );
        const result = await json<{ receipt?: OwnerReceipt }>(
          response,
          response.status === 202 ? 202 : 200,
        );
        if (result.receipt) return result.receipt;
      }
      throw new Error('Wiki apply did not finish');
    };
    const first = await apply(english);
    const character = (
      first.commands!.find((row) => row.key.endsWith(':entity:mr-bennet'))!.result as {
        component: string;
      }
    ).component;
    const firstClaim = (
      first.commands!.find((row) => row.key.endsWith(':claim:0'))!.result as { component: string }
    ).component;
    // The real 1922 Finnish translation has its own bytes and realization. The
    // short quote is located locally; explicit bilingual names confirm identity.
    const parsed = parseFile(fixture(45186), 'txt', { encoding: 'utf8' });
    const exact = 'Rakas Bennet',
      unit = parsed.units.find((item) => item.text.includes(exact))!;
    const start = unit.text.indexOf(exact),
      locator = parsed.locate(unit, start, start + exact.length);
    expect(parsed.verify(locator).quote).toBe(exact);
    const translator = await json<{ agent: string }>(
      await steward.send(
        'POST',
        '/v1/agents',
        {
          profile: 'agent-provision-v1',
          kind: 'person',
          displayName: 'O. A. Joutsen',
        },
        'g856-translator',
      ),
      201,
    );
    const texts: { realization: string; revision: string }[] = [];
    for (const [language, edition] of [
      ['en', 1342],
      ['fi', 45186],
    ] as const) {
      const realization = native();
      const source = texts[0]
        ? {
            kind: 'realization',
            work: seed.work,
            realization: texts[0].realization,
            revision: texts[0].revision,
          }
        : { kind: 'unresolved', work: seed.work };
      const saved = await json<{ revision: string }>(
        await call('PUT', `/v1/works/${short(seed.work)}/realizations/${short(realization)}`, {
          profile: 'realization-v1',
          expectedHead: null,
          actingSubject: actor,
          id: realization,
          language,
          kind: language === 'en' ? 'original' : 'translation',
          translators: language === 'en' ? [] : [translator.agent],
          publishers: [],
          source,
          status: 'official',
          verification: 'verified',
          evidence: `https://www.gutenberg.org/ebooks/${edition}`,
        }),
      );
      texts.push({ realization, revision: saved.revision });
    }
    const finnish: WikiExtraction = {
      ...english,
      source: {
        ...english.source,
        representationSha256:
          locator.source.type === 'external' ? locator.source.representationSha256 : '',
        language: 'fi',
      },
      units: [
        {
          id: unit.id,
          ordinal: unit.ordinal,
          label: unit.label.slice(0, 200),
          occurrence: seed.chapters[0]!,
        },
      ],
      entities: [
        {
          ...english.entities[0]!,
          match: character,
          names: [
            { value: 'Mr. Bennet', language: 'en', kind: 'primary', revealedAt: unit.id },
            { value: 'Hra Bennet', language: 'fi', kind: 'primary', revealedAt: unit.id },
          ],
        },
      ],
      claims: [
        { ...english.claims[0]!, revealedAt: unit.id, evidence: [{ quote: exact, locator }] },
      ],
    };
    const candidates = await mcp<{ items: { status: string; candidates: string[] }[] }>(
      'wiki_candidates',
      {
        actingSubject: actor,
        target: seed.work,
        zone: seed.zone,
        names: [{ value: 'Mr. Bennet', language: 'en' }],
      },
    );
    expect(candidates.items[0]).toMatchObject({ status: 'matched', candidates: [character] });
    expect(await mcp('wiki_validate', { actingSubject: actor, bundle: finnish })).toMatchObject({
      status: 'acceptable',
      entities: [{ action: 'reuse' }],
    });
    await apply(finnish);
    const facts = await json<{ groups: { items: { kind: string; statement?: string }[] }[] }>(
      await call('GET', `/v1/resources/${short(character)}/statements?position=all`),
    );
    expect(facts.groups.flatMap((group) => group.items).map((item) => item.statement)).toContain(
      firstClaim,
    );
    const editions = await json<{ items: { work: string; language: string }[] }>(
      await call('GET', `/v1/works/${short(seed.work)}/realizations`),
    );
    expect(editions.items.map((item) => [item.work, item.language])).toEqual(
      expect.arrayContaining([
        [seed.work, 'en'],
        [seed.work, 'fi'],
      ]),
    );
  } finally {
    await f.stop();
  }
}, 180_000);

// Omitted earlier chapters in the subsequent bundle never become deletions.
test(
  'G856: later chapter deltas preserve prior publication and exact historical exports',
  wikiDeltaJourney,
  180_000,
);
