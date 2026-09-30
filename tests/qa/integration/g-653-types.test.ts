import { expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { typeRegistry } from '../../../packages/model/src/generated/types.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AdmittedTypeStore } from '../../../services/main/src/modules/types/store.ts';
import {
  admittedTypes,
  assertRegisteredTypeSnapshot,
  compiledType,
  installRegisteredTypes,
  type RegisteredType,
} from '../../../services/main/src/modules/types/registry.ts';
import {
  TYPE_ADMISSION_COST,
  TYPES_READ_COST,
  type TypeDefinition,
  type TypeAdmissionResult,
} from '../../../services/main/src/modules/types/contract.ts';
import {
  activateMetadataWork,
  metadataWorkRequestDigest,
} from '../../../services/main/src/modules/work/activate.ts';
import { workScalarEditDigest } from '../../../services/main/src/modules/work/edit.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

test('G653: administrator admission, concurrent replay, live retyping, facets, retirement and retained edits', async () => {
  const directory = resolve('.temp', `g-653-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read type:admit',
  );
  let time = 0;
  const types = new AdmittedTypeStore(f.accessPool, () => time);
  const content = new ContentCore(f.pool);
  const deps = {
    environment: f.env,
    account: f.account.verifier,
    access: f.access,
    accessPolicy: new AccessPolicyOwner(f.accessPool),
    types,
    content,
    contentAuthoring: content,
    mediaAccess: new MediaAccessBatchReader(f.accessPool, f.env.fuseki),
    realmReplies: new RealmReplyStore(new RealmReplyContentStore(f.pool), content, f.access, f.env),
  };
  // Construct the HTTP app before admission; no app restart can refresh its validators.
  const app = createMainApp(f.env.fuseki, deps);
  const call = (
    method: string,
    path: string,
    body?: object,
    key = randomUUID(),
    token: string | null = f.account.tokenA,
  ) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const body = await response.json();
    expect({ status: response.status, ...(response.status !== status ? { body } : {}) }).toEqual({
      status,
    });
    return body as T;
  };
  try {
    const before = await json<{ digest: string }>(await call('GET', '/v1/types'));
    const webNovel = 'https://rezics.com/vocab/WebNovel';
    const {
      default: _default,
      creatable: _creatable,
      ...book
    } = typeRegistry['https://schema.org/Book'];
    const key = randomUUID();
    const input = {
      profile: 'type-admission-v1',
      ...book,
      type: webNovel,
      priority: 0,
      labels: {
        en: { one: 'Web novel', other: 'Web novels' },
        'zh-Hant': { one: '網路小說', other: '網路小說' },
        'zh-Hans': { one: '网络小说', other: '网络小说' },
        ja: { one: 'ウェブ小説', other: 'ウェブ小説' },
        ko: { one: '웹 소설', other: '웹 소설' },
        de: { one: 'Webroman', other: 'Webromane' },
        fr: { one: 'Roman en ligne', other: 'Romans en ligne' },
        es: { one: 'Novela web', other: 'Novelas web' },
      },
      actingSubject: f.actor,
      idempotencyKey: key,
    };
    await json(await call('POST', '/v1/types', input, key), 403);
    await f.grant('type:admit', 'type.admit');
    await json(await call('POST', '/v1/types', input, key, f.account.tokenB), 403);
    const admitted = await Promise.all([
      call('POST', '/v1/types', input, key),
      call('POST', '/v1/types', input, key),
    ]);
    const outcomes = await Promise.all(
      admitted.map((response) => json<TypeAdmissionResult>(response)),
    );
    expect(outcomes.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0].definition.type).toBe(webNovel);
    await json(await call('POST', '/v1/types', { ...input, priority: 1 }, key), 409);
    const after = await json<{ digest: string; types: { type: string }[] }>(
      await call('GET', '/v1/types'),
    );
    expect(after.digest).not.toBe(before.digest);
    expect(after.types.filter((type) => type.type === webNovel)).toHaveLength(1);
    // Another process refreshes only when its bounded TTL expires.
    const second = new AdmittedTypeStore(f.accessPool, () => time);
    await second.refresh();
    const resourceKey = randomUUID();
    const resource = {
      ...input,
      type: `urn:rezics:g653:resource:${randomUUID()}`,
      base: 'resource',
      idempotencyKey: resourceKey,
    };
    let reads = 0;
    // The SQL query evidence below is recorded on the connected client instead of the Pool wrapper.
    const connect = f.accessPool.connect.bind(f.accessPool);
    f.accessPool.connect = (async () => {
      const client = await connect();
      const original = client.query.bind(client);
      client.query = ((...args: Parameters<typeof client.query>) => {
        reads++;
        return original(...args);
      }) as typeof client.query;
      const release = client.release.bind(client);
      client.release = (...args) => {
        client.query = original;
        client.release = release;
        return release(...args);
      };
      return client;
    }) as typeof f.accessPool.connect;
    await json(await call('POST', '/v1/types', resource, resourceKey));
    expect(reads).toBeLessThanOrEqual(TYPE_ADMISSION_COST.ownerStatements);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    await second.refresh();
    expect(reads).toBe(0);
    time += 5_001;
    await second.refresh();
    expect(reads).toBeLessThanOrEqual(TYPE_ADMISSION_COST.ownerStatements);
    expect(reads).toBeGreaterThan(0);
    f.accessPool.connect = connect;
    const refresh = types.refresh.bind(types);
    let lostResponse = true;
    types.refresh = async (force) => {
      if (force && lostResponse) {
        lostResponse = false;
        throw new Error('lost response after registry commit');
      }
      await refresh(force);
    };
    const retryKey = randomUUID();
    const retryInput = {
      ...resource,
      type: `urn:rezics:g653:retry:${randomUUID()}`,
      idempotencyKey: retryKey,
    };
    await json(await call('POST', '/v1/types', retryInput, retryKey), 503);
    expect(
      (await json<TypeAdmissionResult>(await call('POST', '/v1/types', retryInput, retryKey)))
        .replayed,
    ).toBe(true);
    types.refresh = refresh;
    // Keep the owner command check separate from G-842's still-closed POST schema.
    const principal = await f.account.verifier.verify(
      new Request('http://main.local', {
        headers: { authorization: `Bearer ${f.account.tokenA}` },
      }),
      ['work:create'],
    );
    const create = async (
      title: string,
      semanticTypes: string[],
      profile?: 'work-kind-v1' | 'work-kind-v2',
    ) => {
      const digest = metadataWorkRequestDigest(title, semanticTypes, 'en');
      const registered = await f.access.register({
        principal,
        actingSubject: f.actor,
        scope: 'work:create:root',
        action: 'work.create',
        idempotencyKey: randomUUID(),
        requestDigest: digest,
        workSemanticTypes: semanticTypes,
      });
      const admission = await f.access.claim(registered.id, digest, principal);
      const fuseki = profile
        ? new Proxy(f.env.fuseki, {
            get(target, property) {
              if (property === 'commandWithReceipt')
                return (envelope: CommandEnvelope) =>
                  target.commandWithReceipt({
                    ...envelope,
                    validations: envelope.validations.map((validation) =>
                      validation.profile === 'work-kind-v3'
                        ? {
                            ...validation,
                            profile,
                            sha256: profileRegistry[profile].sha256,
                            shape: profileRegistry[profile].shapes[0],
                          }
                        : validation,
                    ),
                  });
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        : f.env.fuseki;
      const created = await activateMetadataWork(
        { ...f.env, fuseki },
        { admission, title, language: 'en', semanticTypes },
      );
      await f.access.recordGraphOutcome(admission.id, {
        outcome: 'succeeded',
        receipt: created.receipt,
        dataEpoch: created.dataEpoch,
        sequence: created.sequence,
        admissionId: admission.id,
        requestDigest: digest,
        authorityEpoch: admission.authorityEpoch,
        scope: admission.scope,
        work: created.work,
        mainVersion: created.mainVersion,
        workRevision: created.workRevision,
        mainRevision: created.mainRevision,
      });
      return created;
    };
    const works = await Promise.all([
      create(`G653 native ${randomUUID()}`, [webNovel]),
      create(`G653 v1 ${randomUUID()}`, ['https://schema.org/Book'], 'work-kind-v1'),
      create(`G653 v2 ${randomUUID()}`, ['https://schema.org/VideoGame'], 'work-kind-v2'),
    ]);
    for (const work of works) {
      await f.grant(`work:edit:${work.work}`, 'work.edit');
      await f.grant(`work:read:${work.work}`, 'work.read');
      const edited = await json<{ revision: string }>(
        await call('PUT', `/v1/works/${shortId(work.work)}/type`, {
          profile: 'work-type-v3',
          expectedHead: work.workRevision,
          types: [webNovel],
          actingSubject: f.actor,
        }),
      );
      // A second retyping traverses the v3 historical anchor as well as the original one.
      const again = await json<{ revision: string }>(
        await call('PUT', `/v1/works/${shortId(work.work)}/type`, {
          profile: 'work-type-v3',
          expectedHead: edited.revision,
          types: [webNovel, 'https://schema.org/Book'],
          actingSubject: f.actor,
        }),
      );
      work.workRevision = again.revision;
      const read = await json<{ types: string[] }>(
        await call(
          'GET',
          `/v1/works/${shortId(work.work)}` + `?actingSubject=${encodeURIComponent(f.actor)}`,
        ),
      );
      expect(read.types).toContain(webNovel);
    }
    await json(
      await call('PUT', `/v1/works/${shortId(works[0].work)}/type`, {
        profile: 'work-type-v3',
        expectedHead: works[0].workRevision,
        types: ['urn:unadmitted:type'],
        actingSubject: f.actor,
      }),
      400,
    );
    const target = works[0];
    await f.grant(`contribution:create:${target.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(
      await call('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: target.work,
        language: 'en',
        body: 'G653 serial story',
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const publication = await json<{ publicationDecision: string }>(
      await call('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`publication:select:${target.mainVersion}`, 'publication.select');
    await json(
      await call('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: target.mainVersion },
        work: target.work,
        contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer',
        actingSubject: f.actor,
      }),
      201,
    );
    const facet = await json<{ facets: { types: { values: { value: string }[] } } }>(
      await call('POST', '/v1/queries', {
        profile: 'public-main-phrase-v1',
        phrase: 'G653 serial',
        language: 'en',
        includeTypes: [webNovel],
      }),
    );
    expect(facet.facets.types.values.some((value) => value.value === webNovel)).toBe(true);
    await json(
      await call(
        'GET',
        `/v1/resources/${shortId(target.work)}/discussion`,
        undefined,
        randomUUID(),
        null,
      ),
    );
    const retireKey = randomUUID();
    const retirement = {
      profile: 'type-retirement-v1',
      type: webNovel,
      expectedRevision: '1',
      actingSubject: f.actor,
      idempotencyKey: retireKey,
    };
    const staleKey = randomUUID();
    await json(
      await call(
        'POST',
        '/v1/types/retirements',
        { ...retirement, expectedRevision: '2', idempotencyKey: staleKey },
        staleKey,
      ),
      409,
    );
    await json(await call('POST', '/v1/types/retirements', retirement, retireKey));
    expect(
      (
        await json<TypeAdmissionResult>(
          await call('POST', '/v1/types/retirements', retirement, retireKey),
        )
      ).replayed,
    ).toBe(true);
    expect(() => metadataWorkRequestDigest('Retired serial', [webNovel])).toThrow();
    await json(
      await call('PUT', `/v1/works/${shortId(target.work)}/type`, {
        profile: 'work-type-v3',
        expectedHead: target.workRevision,
        types: [webNovel],
        actingSubject: f.actor,
      }),
      400,
    );
    const scalarKey = randomUUID();
    const value = { kind: 'string' as const, lexical: '' as const };
    const digest = workScalarEditDigest(target.work, target.workRevision, value);
    // Retained payload validation must still accept the retired description during ordinary edits.
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await json(
      await call(
        'POST',
        `/v1/works/${shortId(target.work)}/scalar-value`,
        {
          profile: 'work-scalar-state-v1',
          expectedHead: target.workRevision,
          scalarValue: value,
          actingSubject: f.actor,
        },
        scalarKey,
      ),
    );
    const retiredRead = await json<{ types: string[] }>(
      await call(
        'GET',
        `/v1/works/${shortId(target.work)}?actingSubject=${encodeURIComponent(f.actor)}`,
      ),
    );
    expect(retiredRead.types).toContain(webNovel);
    // A full but valid response must remain available when the next admission would exceed its bytes.
    const retained: RegisteredType[] = [
      { definition: outcomes[0].definition, revision: '2', lifecycle: 'retired' },
      ...admittedTypes
        .filter((entry) => !compiledType(entry.type))
        .map((definition) => ({
          definition,
          revision: '1',
          lifecycle: 'active' as const,
        })),
    ];
    const largeLabels = Object.fromEntries(
      Object.keys(input.labels).map((locale) => [
        locale,
        { one: '文'.repeat(64), other: '文'.repeat(64) },
      ]),
    ) as TypeDefinition['labels'];
    const bulk: RegisteredType[] = [];
    let overflow: RegisteredType | undefined;
    for (let index = 0; index < TYPES_READ_COST.maxTypes; index++) {
      const row: RegisteredType = {
        definition: {
          ...outcomes[0].definition,
          base: 'resource',
          creatable: false,
          type: `urn:rezics:g653:size:${index}:${'文'.repeat(1800)}`,
          labels: largeLabels,
        },
        revision: '1',
        lifecycle: 'active',
      };
      try {
        assertRegisteredTypeSnapshot([...retained, ...bulk, row]);
      } catch {
        overflow = row;
        break;
      }
      bulk.push(row);
    }
    expect(overflow).toBeDefined();
    expect(bulk.length).toBeGreaterThan(0);
    await f.accessPool.query(
      `INSERT INTO access.admitted_type
      (type_iri, base, labels, presentation, cover, creation, interest, primary_action, priority, admitted_by)
      SELECT type, base, labels, presentation, cover, creation, interest, "primaryAction", priority, $2
      FROM jsonb_to_recordset($1::jsonb) AS x(type text, base text, labels jsonb, presentation text,
        cover text, creation text, interest text, "primaryAction" text, priority bigint)`,
      [JSON.stringify(bulk.map((row) => row.definition)), f.actor],
    );
    await types.refresh(true);
    const bounded = await json<{ digest: string }>(await call('GET', '/v1/types'));
    const {
      default: _overflowDefault,
      creatable: _overflowCreatable,
      ...overflowMetadata
    } = overflow!.definition;
    const overflowKey = randomUUID();
    await json(
      await call(
        'POST',
        '/v1/types',
        {
          profile: 'type-admission-v1',
          ...overflowMetadata,
          actingSubject: f.actor,
          idempotencyKey: overflowKey,
        },
        overflowKey,
      ),
      503,
    );
    expect(
      (
        await f.accessPool.query('SELECT 1 FROM access.admitted_type WHERE type_iri = $1', [
          overflow!.definition.type,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await json<{ digest: string }>(await call('GET', '/v1/types'))).digest).toBe(
      bounded.digest,
    );
    await f.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    try {
      time += 5_001;
      await json(await call('GET', '/v1/types'), 503);
    } finally {
      await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    }
    await json(await call('GET', '/v1/types'));
  } finally {
    installRegisteredTypes([]);
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test('G653: the historical Work anchor guard explicitly retains all three profile generations', () => {
  const java = readFileSync(
    resolve('infra/jena/command-module/src/main/java/com/rezics/jena/ModelMutationPolicy.java'),
    'utf8',
  );
  for (const profile of ['work-type-v1', 'work-type-v2', 'work-type-v3'])
    expect(java).toContain(`validWorkTypeRevision(profiles, data, name, "${profile}")`);
});
