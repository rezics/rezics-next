import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import type { PublicFilterCost } from '../../../src/semantic/public-filter-source-contract.ts';
import {
  installPublicFilterCoveragePage,
  openPublicFilterCoveragePage,
} from '../../../src/search/public-filter-coverage-page.ts';
import type { DefaultPublicFilterRuntime } from '../../../src/search/public-runtime.ts';
import type { PublicFilterConsumerCaptureInput } from '../../../src/search/public-filter-consumer-contract.ts';
import type { OpenSearch } from '../../../src/search/opensearch.ts';
import { measurePublicFilterIteratorSteps } from '../../../src/search/public-filter-consumer.ts';

type PageRead = {
  slots: number;
  snapshot: 'prepared' | 'pit';
  rounds: number;
  finished: boolean;
  cost?: PublicFilterCost;
};
type PageSample = {
  reads: PageRead[];
  engineSearches: number;
  iteratorSteps: number;
  requestBytes: number;
  responseBytes: number;
};

const measured = new AsyncLocalStorage<PageSample>();

type ReadStage = {
  filter: PublicFilterConsumerCaptureInput['filterDocument'];
  slots: number;
  snapshot: 'pit' | 'prepared';
  stage: 'bind' | 'capture' | 'query' | 'consume' | 'finish';
  status?: string;
  reason?: string;
  job?: string;
  inputKeys?: number;
  candidates?: number;
  frontierWrites?: number;
};
const warmup = new AsyncLocalStorage<ReadStage[]>();

export async function observeComposedWarmup<T>(read: () => Promise<T>) {
  const stages: ReadStage[] = [];
  return { value: await warmup.run(stages, read), stages };
}

export async function captureComposedPage<T>(read: () => Promise<T>) {
  const sample: PageSample = { reads: [], engineSearches: 0, iteratorSteps: 0, requestBytes: 0, responseBytes: 0 };
  const value = await measured.run(sample, read);
  return { value, sample };
}

/** Observe only the foreground HTTP call and its children, including engine work outside the consumer meter. */
export async function observeEngineRequest<T>(client: OpenSearch, ...args: Parameters<OpenSearch['request']>) {
  const sample = measured.getStore();
  if (!sample) return client.request<T>(...args);
  const [method, path, body, options] = args;
  const search = /\/_search(?:\/template)?$/.test(path);
  const payload = search && path.endsWith('/_search') ? { ...(body as object), profile: true } : body;
  // OpenSearch settles the serialized input first, then actual response bytes before JSON decoding.
  // Keep the caller's existing allowance and deadline. The transport's own hard cap applies in both cases.
  const original = options?.work;
  let input = true;
  if (search) sample.engineSearches++;
  const result = await client.request<T>(method, path, payload, {
    ...options,
    work: {
      bytes: original?.bytes ?? Number.MAX_SAFE_INTEGER,
      deadline: original?.deadline ?? Number.MAX_SAFE_INTEGER,
      settle(bytes) {
        original?.settle(bytes);
        if (input) sample.requestBytes += bytes;
        else sample.responseBytes += bytes;
        input = false;
      },
    },
  });
  if (search) sample.iteratorSteps += measurePublicFilterIteratorSteps(result.body);
  return result;
}

export function observeComposedReads(runtime: DefaultPublicFilterRuntime): DefaultPublicFilterRuntime {
  const sample = measured.getStore();
  const stages = warmup.getStore();
  if (!sample && !stages) return runtime;
  return {
    ...runtime,
    async bindRequest(...args) {
      const slots = args[0].plan.pageSize;
      assert(slots !== undefined);
      const trace: ReadStage = {
        filter: args[0].plan.filterDocument,
        slots,
        snapshot: args[0].snapshot,
        stage: 'bind',
      };
      stages?.push(trace);
      const bound = await runtime.bindRequest(...args);
      const capture = bound.capture;
      trace.stage = 'capture';
      trace.status = capture.status;
      trace.inputKeys = capture.cost.inputKeys;
      trace.frontierWrites = capture.cost.frontierWrites;
      if (capture.status === 'preparing') trace.job = capture.repair.job;
      if ('reason' in capture) trace.reason = capture.reason;
      if (capture.status !== 'captured') return bound;
      trace.snapshot = capture.queried.snapshot.kind;
      const read: PageRead = { slots, snapshot: capture.queried.snapshot.kind, rounds: 0, finished: false };
      sample?.reads.push(read);
      const operations = { ...bound.operations };
      installPublicFilterCoveragePage(operations, (context, initial) => {
        const page = openPublicFilterCoveragePage(bound.operations, context, initial);
        return {
          ...page,
          async finish() {
            trace.stage = 'finish';
            delete trace.status;
            await page.finish();
            read.finished = true;
            trace.status = 'finished';
          },
          async query(...queryArgs) {
            trace.stage = 'query';
            delete trace.status;
            const result = await page.query(...queryArgs);
            trace.status = result.status;
            trace.candidates = result.cost.candidates;
            if ('reason' in result) trace.reason = result.reason;
            read.rounds++;
            // The native page meter is cumulative through consume, FINAL and disposal.
            // Retain its handle once per read. Summing snapshots would double-count refills.
            read.cost = result.cost;
            return result;
          },
          async consume(...consumeArgs) {
            trace.stage = 'consume';
            delete trace.status;
            await page.consume(...consumeArgs);
            trace.status = 'consumed';
          },
          failure(error) {
            const result = page.failure(error);
            trace.reason ??= result.reason;
            return result;
          },
        };
      });
      return { operations, capture };
    },
  };
}
