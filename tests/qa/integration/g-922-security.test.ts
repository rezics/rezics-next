import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { PostgresRateLimitStore } from '../../../services/main/src/modules/rate-limit/store.ts';
import {
  principalClasses,
  rateLimitBudgets,
} from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { shortId } from '../fixtures/author-credit.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startMediaStack } from './media-support.ts';
import { startHomeStack } from './feed-read-support.ts';

import { checked, publishedWiki, wikiSuitability } from './g-929-wiki-support.ts';

// Owner: wiki history/export (G-693), shared disclosure (G-897).
test('G922-H1: wiki history keeps r18 presentation separate from current Access denial', async () => {
  const wiki = await publishedWiki();
  try {
    const { call, work, reader, holder } = wiki;
    const history = `/v1/wiki/${shortId(work.work)}/history?position=all&actingSubject=${encodeURIComponent(reader.actor)}`;
    expect(
      (await checked<{ claims: unknown[] }>(await call('GET', history, undefined, reader.token)))
        .claims,
    ).toHaveLength(1);
    await holder.grant('governance:platform', 'governance.moderate');
    await checked(
      await call('PUT', `/v1/suitability/${shortId(work.work)}`, {
        actingSubject: holder.actor,
        expectedRevision: null,
        labels: ['r18'],
        basis: 'platform',
      }),
    );
    const direct = await call(
      'GET',
      `/v1/resources/${shortId(work.work)}?position=all&actingSubject=${encodeURIComponent(reader.actor)}`,
      undefined,
      reader.token,
    );
    // Maintainer revision 2026-10-02: interactive ratings classify presentation;
    // the server returns Access-authorized content and the live assessment.
    expect(direct.status).toBe(200);
    const shown = await checked<{ claims: unknown[] }>(
      await call('GET', history, undefined, reader.token),
    );
    expect(shown.claims).toHaveLength(1);
    expect(JSON.stringify(shown)).toContain('Royal identity');
    expect(JSON.stringify(shown)).toContain('Secret royal heir');
    const presentation = await wikiSuitability(wiki);
    expect(presentation.viewer.age).toBe('unknown');
    expect(presentation.items[0]?.target.resource).toBe(work.work);
    expect(presentation.items[0]?.assessment).toMatchObject({
      status: 'assessed',
      labels: ['r18'],
    });
    expect(presentation.items[0]?.eligible).toBe(false);
    expect(presentation.items[0]?.reasons).toContain('age_unknown');
    expect(presentation.items[0]?.reasons).toContain('sexual_opt_in_required');
    await wiki.f.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [
      `work:read:${work.work}`,
    ]);
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${shortId(work.work)}?position=all&actingSubject=${encodeURIComponent(reader.actor)}`,
          undefined,
          reader.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/resources/${shortId(work.work)}?position=all`, undefined, null))
        .status,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/public-previews/${shortId(work.work)}`, undefined, null)).status,
    ).toBe(404);
    const summaries = await checked<{ summaries: { reference: string; status: string }[] }>(
      await call(
        'POST',
        '/v1/resources/summaries',
        {
          profile: 'resource-summary-batch-v1',
          resources: [work.work, work.mainVersion],
          actingSubject: reader.actor,
          position: 'all',
        },
        reader.token,
      ),
    );
    expect(summaries.summaries).toEqual(
      [work.work, work.mainVersion].map((reference) => ({ reference, status: 'unavailable' })),
    );
    const response = await call('GET', history, undefined, reader.token);
    const body = await response.text();
    expect(
      body,
      'A category choice or retained history selection cannot bypass current Access',
    ).not.toContain('Royal identity');
    expect(body).not.toContain('Secret royal heir');
    expect(response.status).toBe(404);
  } finally {
    await wiki.f.stop();
  }
}, 180_000);

// Owner: identity-merge / Work (G-836), editorial authority (G-865).
test('G922-H2: two source reviewers cannot merge a public Work into a private survivor they can only read', async () => {
  const f = await startMediaStack('g-922-merge', { profileCredits: true });
  try {
    const proposer = await f.member('proposer'),
      first = await f.member('first-human'),
      second = await f.member('second-human'),
      owner = await f.member('private-owner');
    const people = [proposer, first, second, owner];
    for (const person of people) await person.grant(`agent:self:${person.actor}`, 'agent.control');
    const tokens = new Map(people.map((person) => [person.token, person.principal]));
    const app = createMainApp(f.fuseki, {
      environment: f.env,
      access: f.access,
      account: {
        verify: async (request) => {
          const principal = tokens.get(
            request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
          );
          if (!principal) throw new Error('Unknown QA bearer');
          return principal;
        },
      },
      platformAccess: new AccessExposure(f.accessPool),
      identityMerge: { accessPool: f.accessPool, contentPool: f.contentPool },
      editorialReview: new EditorialReviewStore(f.accessPool),
    });
    const call = (path: string, body: object, token: string, key = randomUUID()) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
        }),
      );
    const source = await f.publicWork(proposer.actor, ['en'], 'G922 public duplicate');
    const survivor = await f.privateWork(owner.actor, 'G922 private original');
    for (const person of [proposer, first, second])
      await person.grant(`work:read:${survivor.work}`, 'work.read');
    for (const person of [first, second])
      await person.grant(`work:review:${source.work}`, 'work.review');
    expect(
      (
        await f.accessPool.query(
          `SELECT id FROM access.permission_grant
      WHERE scope_id=$1 AND action='work.edit' AND recipient_subject=ANY($2::text[])`,
          [`work:edit:${survivor.work}`, [first.actor, second.actor]],
        )
      ).rows,
    ).toEqual([]);
    const heads = (
      await f.fuseki
        .query(`PREFIX rv: <${RV}> SELECT ?work ?head WHERE { GRAPH <${GRAPHS.current}> {
      VALUES ?work { <${source.work}> <${survivor.work}> } ?work rv:head ?head } }`)
    ).results!.bindings;
    const revision = (work: string) => heads.find((row) => row.work!.value === work)!.head!.value;
    const candidate = {
      operation: 'merge',
      source: { resource: source.work, revision: revision(source.work) },
      survivor: { resource: survivor.work, revision: revision(survivor.work) },
      evidence: [
        { resource: source.work, revision: revision(source.work), locator: 'title-and-grain' },
      ],
    };
    // G-930 may refuse the merge as early as its proposal; any refusal before a
    // redirect is the defended outcome, which the final assertion checks.
    const created = await call(
      '/v1/editorial/proposals',
      {
        profile: 'editorial-proposal-create-v1',
        kind: 'merge',
        target: {
          resource: source.work,
          revision: revision(source.work),
          context: 'urn:rezics:context:global',
        },
        candidate,
        baseHeads: heads.map((row) => ({ component: row.work!.value, head: row.head!.value })),
        evidence: candidate.evidence,
        actingSubject: proposer.actor,
      },
      proposer.token,
    );
    const proposal =
      created.status === 201 ? await checked<{ proposal: string }>(created, 201) : null;
    if (proposal)
      await checked(
        await call(
          `/v1/editorial/proposals/${proposal.proposal}/reviews`,
          {
            profile: 'editorial-proposal-review-v1',
            revision: 1,
            outcome: 'approve',
            message: 'Source review',
            actingSubject: first.actor,
          },
          first.token,
        ),
      );
    const key = randomUUID();
    for (let attempt = 0; proposal && attempt < 16; attempt++) {
      const response = await call(
        `/v1/editorial/proposals/${proposal.proposal}/decisions`,
        {
          profile: 'editorial-proposal-decide-v1',
          revision: 1,
          outcome: 'applied',
          approve: true,
          message: 'Second source review',
          actingSubject: second.actor,
        },
        second.token,
        key,
      );
      if ([403, 409].includes(response.status)) break;
      await checked(response, response.status === 202 ? 202 : 200);
      if (response.status === 200) break;
    }
    const redirect = await f.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
      <${source.work}> rv:mergedInto <${survivor.work}> } }`);
    expect(
      redirect.boolean,
      'Read-only survivor access cannot authorize cross-owner identity/person-state changes',
    ).toBe(false);
  } finally {
    await f.stop();
  }
}, 180_000);

// Owner: library file import (G-854), principal budgets (G-543).
test('G922-M1: library files consume the principal upload budget before parsing or retention', async () => {
  const home = await startHomeStack('g-922-upload');
  let limits: PostgresRateLimitStore | undefined;
  try {
    const agent = await home.provision('G922 importing reader', home.reader.token);
    const options = {
      secret: 'g922-upload-budget-secret-at-least-32-characters',
      serviceClientIds: new Set<string>(),
      trustedProxyPeers: new Set<string>(),
      clientIpHeader: 'x-rezics-client-ip',
    };
    limits = new PostgresRateLimitStore(home.stack.accessPool, options);
    const app = createMainApp(home.stack.fuseki, {
      ...home.deps,
      libraryFiles: new LibraryFileStore(home.stack.contentPool),
      libraryImport: new ReaderLibraryImportStore(home.stack.contentPool),
      rateLimit: {
        options,
        store: limits,
        budgets: rateLimitBudgets(
          JSON.stringify(
            Object.fromEntries(
              principalClasses.map((name) => [
                name,
                { upload: { maximum: 1, seconds: 86400 }, write: { maximum: 10, seconds: 60 } },
              ]),
            ),
          ),
        ),
      },
    });
    const upload = (title: string) =>
      app.handle(
        new Request('http://main.local/v1/me/library-imports', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${home.reader.token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            actingSubject: agent,
            format: 'generic-csv',
            file: `Title\n${title}`,
            mapping: { title: 'Title', statuses: {} },
          }),
        }),
      );
    await checked(await upload('First private source'), 201);
    const response = await upload('Second private source');
    const body = (await response.json()) as { family?: string };
    const retained = (
      await home.stack.contentPool.query(
        'SELECT id FROM reader.library_import_file WHERE agent=$1',
        [agent],
      )
    ).rows;
    expect({ status: response.status, family: body.family, retained: retained.length }).toEqual({
      status: 429,
      family: 'upload',
      retained: 1,
    });
  } finally {
    await limits?.stopExpirySweep();
    await home.stop();
  }
}, 180_000);

// Owner: wiki candidate lookup (G-898), reading-position boundary (G-920).
test('G922-M2: wiki candidate matching cannot identify a later alias at the reader default position', async () => {
  const wiki = await publishedWiki();
  try {
    Object.assign(wiki.deps, { platformAccess: new AccessExposure(wiki.f.accessPool) });
    await grantRecordedPlatformUse(wiki.f.accessPool, wiki.reader.principalId, ['wiki-agents']);
    const { call, work, zone, reader, entity } = wiki;
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${shortId(entity)}/page?actingSubject=${encodeURIComponent(reader.actor)}`,
          undefined,
          reader.token,
        )
      ).status,
    ).toBe(404);
    const result = await checked<{ items: { status: string; candidates: string[] }[] }>(
      await call(
        'POST',
        '/v1/wiki/candidates',
        {
          target: work.work,
          zone,
          actingSubject: reader.actor,
          names: [
            { value: 'Secret royal heir', language: 'en' },
            { value: 'Unknown candidate', language: 'en' },
          ],
        },
        reader.token,
      ),
    );
    expect(
      result.items[0]?.status,
      'Hidden aliases must not alter status, identities or ambiguity',
    ).toBe(result.items[1]?.status);
    expect(result.items[0]?.candidates).toEqual(result.items[1]?.candidates);
  } finally {
    await wiki.f.stop();
  }
}, 180_000);
