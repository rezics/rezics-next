import { createHash } from 'node:crypto';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import { convertBangumi } from '../../../../packages/conversion/src/bangumi.ts';
import { convertVndb } from '../../../../packages/conversion/src/vndb.ts';
import { convertWikidata } from '../../../../packages/conversion/src/wikidata.ts';
import { convertOpenLibrary } from '../../../../packages/conversion/src/open-library.ts';
import type { DriverOptions, ImportApiDriver } from '../../../../specs/imports-api-driver.ts';
import { processImage } from '../../src/content/image-job.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { createApiPopulation } from './api-population.ts';

/** The sole composition owner for public import outcomes and native observations. */
export async function openImportApiFixture(options: DriverOptions): Promise<ImportApiDriver> {
  const runtime = await openApiRuntime(options);
  try {
    const observer = await runtime.time('governance observer', () => openApiObserver(runtime));
    const population = createApiPopulation(runtime);
    return {
      growthDatabase: runtime.database,
      population: population.population,
      properties: { title: 'schema:name', summary: 'schema:abstract', cover: 'schema:image', externalId: 'wdt:P648' },
      run: runtime.run,
      read: observer.read,
      effects: observer.effects,
      commands: (run) => run.exchanges.flatMap((e) => (e.request.body as { commands: BatchCommand[] }).commands),
      document: observer.document,
      async media(proposal) {
        const id = String(proposal.statement?.value.content);
        const native = await runtime.mediaBoundary.observe(id);
        const variant = native.variants[0];
        if (!variant) throw new Error('Imported media has no stored variant');
        const captured = runtime.captures.find(
          (c) =>
            new URL(c.request.url).pathname === '/v1/media:importFromUrl' &&
            JSON.parse(c.body).containerId === proposal.subjectId,
        );
        if (!captured) throw new Error('No captured public media request');
        const actor = await runtime.identity.access.authenticate(
          captured.request.headers.get('authorization')!.slice(7),
          { pool: runtime.database.pool, deadline: Date.now() + 10000 },
        );
        const trace = await runtime.mediaBoundary.capture();
        const response = await observer.disclose(proposal);
        const source = await runtime.mediaBoundary.source(native.row.sourceUrl);
        const url = `/v1/media/${id}:authorizeDownload?variant=${variant.format}-${variant.width}`;
        return {
          id,
          state: native.row.state,
          transitions: [...native.transitions],
          role: native.row.purpose,
          credit: native.row.credit,
          provenance: native.row.provenance,
          digest: createHash('sha256').update(variant.bytes).digest('hex'),
          sourceBytes: source.bytes,
          storedBytes: variant.bytes,
          response: { ...response, url: `https://kernel.import.test${url}` },
          sharedSharpPipeline:
            trace.registrations.some(
              (r) => r.name === CONTENT_WORKFLOWS.importFromUrl && r.handler === processImportedMedia,
            ) && trace.registrations.some((r) => r.name === CONTENT_WORKFLOWS.image && r.handler === processImage),
          transport: {
            request: {
              url: captured.request.url,
              method: captured.request.method,
              headers: captured.request.headers,
              body: JSON.parse(captured.body),
            },
            importerId: runtime.identity.bulk.accountId,
            verifiedSub: actor.accountId,
            websiteSession: captured.request.headers.has('cookie'),
            serviceToken: actor.kind !== 'account',
            importerFetchedBytes: runtime.captures
              .filter((c) => !c.request.url.startsWith('https://kernel.import.test/'))
              .reduce((n, c) => n + Buffer.byteLength(c.body), 0),
            contentFetches: trace.sourceRequests.map((r) => r.url),
          },
        };
      },
      async mediaImports() {
        return {
          requests: runtime.captures.filter((c) => new URL(c.request.url).pathname === '/v1/media:importFromUrl')
            .length,
          jobs: (await runtime.mediaBoundary.capture()).executedJobs,
        };
      },
      async fence(source, externalId, fieldGroup, as) {
        const response = await runtime.request(
          `/v1/sourceFences:check?${new URLSearchParams({ source, externalId, fieldGroup })}`,
          undefined,
          as === 'bulk' ? runtime.bulk.bearer : as === 'ordinary' ? runtime.identity.ordinary.bearer : undefined,
        );
        return { status: response.status, headers: response.headers, body: await response.json() };
      },
      disclose: observer.disclose,
      async baseline(source) {
        const native = runtime.importer.session.store.source(source);
        return { snapshot: native.generation, records: native.count };
      },
      async acknowledged(key) {
        const command = runtime.commands.get(key)?.command;
        if (!command) return false;
        const database = runtime.importer.session.store.database;
        const row = database
          .query('SELECT acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?')
          .get(command.source.source, command.source.external_id, key) as { acknowledgement: string | null } | null;
        return row?.acknowledgement !== null && row?.acknowledgement !== undefined;
      },
      async recordAcknowledged(source, externalId) {
        return runtime.importer.session.store.key(source, externalId).acknowledged !== null;
      },
      receipt: runtime.receipt,
      restart: runtime.restart,
      setBulkPermission: (allowed) => runtime.identity.setBulkPermission(allowed),
      async replay(exchange, replayOptions) {
        const headers = new Headers(exchange.request.headers);
        if (replayOptions?.as === 'ordinary')
          headers.set('authorization', `Bearer ${runtime.identity.ordinary.bearer}`);
        const response = await runtime.replay(
          new Request(exchange.request.url, {
            method: exchange.request.method,
            headers,
            body: exchange.request.serializedBody,
          }),
        );
        return { status: response.status, headers: response.headers, body: await response.json() };
      },
      adopt: observer.adopt,
      takedown: observer.takedown,
      rateLimit: runtime.rateLimit,
      async convert(source, record, converterRevision, context) {
        const native = record as Record<string, unknown>;
        const key =
          source === 'bangumi'
            ? String(native.id)
            : source === 'wikidata'
              ? String(native.id)
              : source === 'openlibrary'
                ? String(native.key)
                : String((native.vn as { id: string }).id);
        const revision =
          source === 'wikidata'
            ? Object.hasOwn(native, 'lastrevid')
              ? String(native.lastrevid)
              : 'unversioned'
            : source === 'openlibrary'
              ? String(native.revision)
              : source === 'vndb'
                ? String((native.entry_meta as { revision: number }).revision)
                : null;
        const input = { external_id: key, record_revision: revision, record };
        const convert = {
          bangumi: convertBangumi,
          vndb: convertVndb,
          wikidata: convertWikidata,
          openlibrary: convertOpenLibrary,
        }[source];
        const raw = convert(input, { ...context, source }, { converterRevision });
        return {
          raw,
          statements: raw.proposals
            .filter((c): c is Extract<BatchCommand, { op: 'propose' }> => c.op === 'propose')
            .map((c) => c.statement) as BatchStatement[],
        };
      },
      seed: population.seed,
      async measure(action) {
        // Setup warmed the native query objects; a minute of idleness before this measurement expires them.
        await runtime.warm();
        return runtime.measurement.measure(action);
      },
      close: runtime.close,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
