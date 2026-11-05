import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { tupleRoute } from '../../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { isRelationProperty } from '../../../src/semantic/item.ts';
import { readPartition } from '../../../src/partition/partition.ts';
import { linksCaughtUp } from '../../../src/semantic/link-freshness.ts';
import { readSubjectSummaries, type SummaryReaderDependencies } from '../../../src/semantic/summaries.ts';
import { capture } from '../../support/growth.ts';
import { openApiRuntime } from '../../imports/api-runtime.ts';
import { openApiObserver } from '../../imports/api-observer.ts';

const relation = 'rezics:alternativeVersion';
type Record = { id: string; media: string; source: Source };
type ObjectValue = { [key: string]: unknown };
type Surface = 'shared' | 'subject' | 'related' | 'graph' | 'links';

/** Setup uses ordinary native producers; observations return the production objects unchanged. */
export async function createSharedSummaryCoverFixture() {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
  });
  const readerPool = runtime.database.openPool({ max: 1 });
  let queries = 0;
  readerPool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      queries++;
      return query(...args);
    }) as PoolClient['query'];
  });
  let ending: Promise<void> | undefined;
  const close = () => (ending ??= runtime.close());
  try {
    const editor = await openApiObserver(runtime);
    const access = runtime.identity.access;
    const actor = await access.authenticate(editor.bearer, {
      pool: readerPool,
      deadline: Date.now() + 30_000,
    });
    const anchors = new Map<string, string>();
    const references = [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: {
              type: 'value' as const,
              content: 'https://catalogue.example.test/licensed',
            },
          },
        ],
      },
    ];
    function source(external_id: string = randomUUID(), field_group: Source['field_group'] = 'facts'): Source {
      return {
        source: 'summarycovers',
        external_id,
        field_group,
        record_revision: '1',
        digest: 'c'.repeat(64),
        converter_revision: '1',
      };
    }
    async function required(path: string, body?: unknown, bearer = editor.bearer, status = 200) {
      const response = await runtime.request(path, body, bearer);
      if (response.status !== status)
        throw new Error(`Native cover fixture ${path}: HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    }
    async function batch(commands: BatchCommand[]) {
      const result = (await required('/v1/subjects:batchWrite', { commands }, runtime.bulk.bearer)) as BatchWriteResult;
      for (const entry of result.results)
        if (!('value' in entry)) throw new Error(`Native cover batch: ${JSON.stringify(entry)}`);
      return result.results;
    }
    async function create(
      type = 'schema:Book',
      labels = { en: 'Licensed catalogue title', ja: '日本語の題名' },
      provenance = source(),
    ) {
      const [result] = await batch([
        {
          op: 'create',
          key: randomUUID(),
          source: provenance,
          subject: { type, labels },
        },
      ]);
      if (!result || !('value' in result) || !('id' in result.value))
        throw new Error('Missing native subject creation');
      return { id: result.value.id, source: provenance };
    }
    const acceptedCandidates = new Set<string>();
    const targets = new Map<string, string>();
    async function select(
      id: string,
      property: string,
      selection: {
        candidate: string;
        rank: 'preferred' | 'normal' | 'deprecated';
      }[],
    ): Promise<void> {
      const target = targets.get(selection[0]?.candidate ?? '');
      if (selection.some((entry) => targets.get(entry.candidate) !== target)) {
        for (const entry of selection) await select(id, property, [entry]);
        return;
      }
      const listing = await required(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100', ...(target ? { target } : {}) })}`,
      );
      for (const entry of selection) {
        const accepted = listing.candidates.find(
          (candidate: { id: string; acceptance?: unknown }) => candidate.id === entry.candidate,
        );
        if (!accepted) throw new Error(`Missing actual candidate ${entry.candidate}: ${JSON.stringify(listing)}`);
        if (!acceptedCandidates.has(entry.candidate)) {
          await required(`/v1/subjects/${id}/candidates/${entry.candidate}:accept`, {
            context: GLOBAL_CONTEXT,
            expected_head: null,
          });
          acceptedCandidates.add(entry.candidate);
        }
      }
      await required(`/v1/subjects/${id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        ...(target ? { target } : {}),
        mode: 'replace',
        selection,
        expected_head: listing.adoption?.head ?? null,
      });
    }
    async function propose(
      id: string,
      property: string,
      content: unknown,
      provenance: Source,
      qualifiers?: BatchStatement['qualifiers'],
    ) {
      const statement: BatchStatement = {
        property: { id: property },
        value: { type: 'value', content },
        references,
        ...(qualifiers ? { qualifiers } : {}),
      };
      const [result] = await batch([
        {
          op: 'propose',
          key: randomUUID(),
          source: provenance,
          subject: id,
          statement,
        },
      ]);
      if (!result || !('value' in result) || !('candidate' in result.value))
        throw new Error('Missing native candidate creation');
      const candidate = result.value.candidate;
      if (isRelationProperty(bundledRelease, property) && typeof content === 'string') targets.set(candidate, content);
      return candidate;
    }
    async function adopt(
      id: string,
      property: string,
      content: unknown,
      provenance: Source,
      qualifiers?: BatchStatement['qualifiers'],
    ) {
      const candidate = await propose(id, property, content, provenance, qualifiers);
      await select(id, property, [{ candidate, rank: 'normal' }]);
      return candidate;
    }
    async function importCover(id: string, provenance: Source) {
      const sourceUrl = `https://lain.bgm.tv/${randomUUID()}.png`;
      await runtime.mediaBoundary.source(sourceUrl);
      const request: MediaImportRequest = {
        containerId: id,
        sourceUrl,
        credit: {
          rightsHolder: 'Native fixture artist',
          via: {
            name: 'Licensed catalogue',
            url: 'https://catalogue.example.test/licensed',
          },
          license: 'LicenseRef-unknown',
          obligations: [],
        },
        provenance: { ...provenance, field_group: 'cover', references },
      };
      const accepted = (await required(
        '/v1/media:importFromUrl',
        request,
        runtime.bulk.bearer,
        202,
      )) as MediaImportAccepted;
      const media = accepted.media.id;
      await runtime.mediaBoundary.drain({
        mediaIds: [media],
        maxJobs: 16,
        signal: AbortSignal.timeout(30_000),
      });
      const status = (await required(
        `/v1/media/${media}:importStatus`,
        undefined,
        runtime.bulk.bearer,
      )) as MediaImportStatus;
      if (status.media.state !== 'available') throw new Error(`Native cover is ${status.media.state}`);
      return media;
    }
    async function seedCover(provenance = source(), type = 'schema:Book') {
      // Native create claims one subject per source record. Keep that identity
      // independent so several actual subjects can share a licensed cover tuple.
      const created = await create(type);
      const coverSource = { ...provenance, field_group: 'cover' as const };
      const media = await importCover(created.id, coverSource);
      const candidate = await adopt(created.id, 'schema:image', media, coverSource);
      return { ...created, source: coverSource, media, candidate };
    }
    async function converge(ids: string[]) {
      const seen = [];
      for (const partition of new Set(ids.map((id) => partitionOf(routeOf(id)!)))) {
        const state = await readPartition(runtime.database.pool, partition);
        if (!state) throw new Error('Missing native subject home');
        seen.push({ partition, epoch: state.epoch, position: state.position });
      }
      for (const id of ids)
        if (!(await linksCaughtUp(runtime.database.pool, seen, id, Date.now() + 30_000)))
          throw new Error('Registered native projection did not converge');
    }
    function dependencies(): SummaryReaderDependencies {
      return {
        pool: readerPool,
        routeKey: runtime.identity.routeKey,
        access,
        actor,
        deadline: Date.now() + 30_000,
      };
    }
    async function shared(
      ids: readonly string[],
      languages: readonly string[] = [],
      maySeeCover?: SummaryReaderDependencies['maySeeCover'],
    ) {
      return readSubjectSummaries({ ...dependencies(), ...(maySeeCover ? { maySeeCover } : {}) }, ids, { languages });
    }
    return {
      runtime,
      readerPool,
      create,
      async selectDeprecatedImage(id: string, candidate: string) {
        const listing = await required(
          `/v1/subjects/${id}/candidates?${new URLSearchParams({ property: 'schema:image', context: GLOBAL_CONTEXT, limit: '100' })}`,
        );
        return runtime.request(
          `/v1/subjects/${id}:adopt`,
          {
            context: GLOBAL_CONTEXT,
            property: 'schema:image',
            mode: 'replace',
            selection: [{ candidate, rank: 'deprecated' }],
            expected_head: listing.adoption?.head ?? null,
          },
          editor.bearer,
        );
      },
      source,
      seedCover,
      importCover,
      propose,
      select,
      adopt,
      converge,
      shared,
      tupleHome(record: Record) {
        return partitionOf(tupleRoute(runtime.identity.routeKey, record.source.source, record.source.external_id));
      },
      async seedPair() {
        const primary = await seedCover();
        const independent = await seedCover();
        const anchor = await create();
        await adopt(
          primary.id,
          relation,
          anchor.id,
          primary.source.field_group === 'cover' ? { ...primary.source, field_group: 'facts' } : primary.source,
        );
        await adopt(anchor.id, relation, primary.id, anchor.source);
        anchors.set(primary.id, anchor.id);
        await converge([primary.id, independent.id, anchor.id]);
        return { primary, independent };
      },
      async observe(surface: Surface, id: string): Promise<{ httpStatus: number | null; value: ObjectValue | null }> {
        if (surface === 'shared')
          return {
            httpStatus: null,
            value: (await shared([id])).get(id) ?? null,
          };
        const anchor = anchors.get(id);
        if (surface !== 'subject' && !anchor) throw new Error('Missing actual relation anchor');
        const path =
          surface === 'subject'
            ? `/v1/subjects/${id}`
            : surface === 'related'
              ? `/v1/subjects/${anchor}`
              : surface === 'graph'
                ? `/v1/subjects/${anchor}/graph?${new URLSearchParams({ property: relation, direction: 'both', depth: '1' })}`
                : `/v1/subjects/${anchor}/links?${new URLSearchParams({ property: relation })}`;
        const response = await runtime.request(path, undefined, editor.bearer);
        const body = await response.json();
        const value =
          response.status !== 200
            ? null
            : surface === 'subject'
              ? body.summary
              : surface === 'related'
                ? body.related[id]
                : surface === 'graph'
                  ? body.nodes.find((node: { id: string }) => node.id === id)?.summary
                  : body.links.find((link: { subject: string }) => link.subject === id)?.summary;
        return { httpStatus: response.status, value: value ?? null };
      },
      async takeDown(record: Record, field: 'cover' | 'summary') {
        return runtime.request(
          '/v1/sourceFences:takedown',
          {
            source: record.source.source,
            externalId: record.source.external_id,
            fieldGroup: field,
            reason: 'Native rights complaint',
          },
          editor.bearer,
        );
      },
      async pauseProjection() {
        // The complete registered worker (including its native link relay) was running
        // during setup. Graceful close drains it and leaves durable downstream queues intact.
        await runtime.mediaBoundary.close();
      },
      nativeQueryCount: () => queries,
      async readWithoutRoutingKey(id: string) {
        const { routeKey: ignored, ...missing } = dependencies();
        // Deliberately exercise the runtime precondition, without manufacturing any result.
        // @ts-expect-error Missing trusted internal routing configuration.
        return readSubjectSummaries(missing, [id]);
      },
      capture: <T>(operation: () => Promise<T>) => capture(runtime.database, operation, { includeBackends: true }),
      takeDownMedia: (media: string) =>
        required(`/v1/media/${media}:takeDown`, {
          reason: 'Native rights complaint',
        }),
      takeDownSubject: (id: string) =>
        required(`/v1/subjects/${id}:takedown`, {
          notice: {
            complaint: 'Native moderation complaint',
            received_at: new Date().toISOString(),
          },
        }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
