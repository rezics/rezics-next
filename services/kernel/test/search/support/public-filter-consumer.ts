import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { KernelClock } from '../../../src/clock.ts';
import { createSubjectIndex, subjectIndexName } from '../../../src/search/indices.ts';
import { SearchUnavailableError, type OpenSearch } from '../../../src/search/opensearch.ts';
import type {
  PublicFilterConsumerContext,
  PublicFilterConsumerOperationsFactory,
} from '../../../src/search/public-filter-consumer-contract.ts';
import type {
  PublicFilterProjectionMeaning,
  PublicFilterSource,
} from '../../../src/semantic/public-filter-source-contract.ts';

export const publicFilterConsumerModule = '../../../src/search/public-filter-consumer.ts';
export const publicFilterConsumerFactoryExport = 'createPublicFilterConsumerOperations';

/** Real exported dependency for the Semantic suite. No DB/Auth/release/registry provisioning. */
export async function createPublicFilterConsumerFixture(
  config: Readonly<{
    pool: Pool;
    source: PublicFilterSource;
    clock: KernelClock;
    context: PublicFilterConsumerContext;
    search: OpenSearch;
    meaning: PublicFilterProjectionMeaning;
  }>,
) {
  // Load the actual producer, never a permissive port or a successful missing-producer fallback.
  const path = new URL(publicFilterConsumerModule, import.meta.url).pathname;
  expect(await Bun.file(path).exists(), `Missing native Search producer ${path}`).toBe(true);
  const module = await import(path);
  expect(typeof module[publicFilterConsumerFactoryExport], 'Missing native Search consumer factory').toBe('function');
  const factory: PublicFilterConsumerOperationsFactory = module[publicFilterConsumerFactoryExport];

  // Randomness names owned engine resources ONLY. Identity evidence is read from native settings/PIT.
  const prefix = `pf-${randomUUID().slice(0, 8)}-`;
  const physicalTarget = subjectIndexName(prefix, 1);
  type Phase = 'write' | 'refresh';
  type Fault = 'hold' | 'disconnect_before' | 'disconnect_after';
  type ReceiptKind = 'write' | 'explicit_refresh' | 'bulk_wait_for' | 'other';
  type Gate = {
    phase: Phase;
    fault: Fault;
    entered: (point: Readonly<{ kind: ReceiptKind; stage: 'before_send' | 'after_response' }>) => void;
    wait: Promise<void>;
    release: () => void;
  };
  let next: Gate | undefined;
  const held = new Set<Gate>();
  let responses = 0;
  const receipts: { kind: ReceiptKind; response: unknown }[] = [];
  function arm(phase: Phase, fault: Fault = 'hold') {
    if (next) throw new Error('A native transport control is already armed');
    let entered!: Gate['entered'];
    let release!: () => void;
    const reached = new Promise<Parameters<Gate['entered']>[0]>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    next = { phase, fault, entered, wait, release };
    return { reached, release };
  }
  async function barrier(gate: Gate, kind: ReceiptKind, stage: 'before_send' | 'after_response') {
    held.add(gate);
    gate.entered({ kind, stage });
    await gate.wait;
    held.delete(gate);
  }
  function take(phase: Phase | undefined) {
    if (phase === undefined || next?.phase !== phase) return;
    const gate = next;
    next = undefined;
    return gate;
  }
  async function transport<T>(
    phase: Phase | undefined,
    kind: (typeof receipts)[number]['kind'],
    send: () => Promise<T>,
  ): Promise<T> {
    const gate = take(phase);
    if (gate) {
      await barrier(gate, kind, 'before_send');
      if (gate.fault === 'disconnect_before')
        throw new SearchUnavailableError('Native fixture disconnected before send');
    }
    // A before-send fault still prevents the genuine bulk, even though its ordinary hold point
    // is response completion. Do not relabel an already-applied write as disconnected-before.
    if (kind === 'bulk_wait_for' && next?.phase === 'refresh' && next.fault === 'disconnect_before') {
      const before = take('refresh')!;
      await barrier(before, kind, 'before_send');
      throw new SearchUnavailableError('Native fixture disconnected before send');
    }
    const result = await send();
    responses++;
    receipts.push({ kind, response: result });
    if (gate?.fault === 'disconnect_after')
      throw new SearchUnavailableError('Native fixture lost response after actual engine effect');
    // wait_for is a real native visibility response, not write dispatch or an arbitrary bulk 200.
    // Hold that original response before the producer receives it; never issue another refresh.
    if (kind === 'bulk_wait_for') {
      const completion = take('refresh');
      if (completion) {
        await barrier(completion, kind, 'after_response');
        if (completion.fault !== 'hold')
          throw new SearchUnavailableError('Native fixture lost wait_for response after actual engine effect');
      }
    }
    return result;
  }
  const controlled: OpenSearch = {
    request<T = unknown>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      options?: Parameters<OpenSearch['request']>[3],
    ) {
      const url = new URL(path, 'http://native.fixture');
      const explicit = /\/_refresh$/.test(url.pathname);
      const write =
        (method === 'PUT' || method === 'DELETE' || method === 'POST') && /_doc|_bulk|_update/.test(url.pathname);
      const waitFor =
        /\/_bulk$/.test(url.pathname) && (options?.query?.refresh ?? url.searchParams.get('refresh')) === 'wait_for';
      return transport(
        explicit ? 'refresh' : write ? 'write' : undefined,
        explicit ? 'explicit_refresh' : waitFor ? 'bulk_wait_for' : write ? 'write' : 'other',
        () => config.search.request<T>(method, path, body, options),
      );
    },
    bulk<T = unknown>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) {
      return transport('write', options?.query?.refresh === 'wait_for' ? 'bulk_wait_for' : 'write', () =>
        config.search.bulk<T>(lines, options),
      );
    },
  };
  await createSubjectIndex(config.search, prefix, 1);
  let operations: Awaited<ReturnType<PublicFilterConsumerOperationsFactory>>;
  try {
    operations = await factory({
      pool: config.pool,
      source: config.source,
      clock: config.clock,
      search: controlled,
      context: config.context,
      physicalTarget,
      meaning: config.meaning,
    });
  } catch (error) {
    await config.search.request('DELETE', `/${physicalTarget}`);
    throw error;
  }
  async function incarnation() {
    const response = await config.search.request<Record<string, { settings: { index: { uuid: string } } }>>(
      'GET',
      `/${physicalTarget}/_settings`,
    );
    const uuid = response.body[physicalTarget]!.settings.index.uuid;
    expect(uuid).toBeString();
    expect(uuid.length).toBeGreaterThan(0);
    return uuid;
  }
  let closed: Promise<void> | undefined;
  return {
    operations,
    physicalTarget,
    incarnation,
    arm,
    engineResponses: () => responses,
    /** Exercise the SAME native transport with owned test documents; never an ACK setter. */
    transport: controlled,
    nativeReceipts: () => receipts.slice(),
    /** Real delete/create with the SAME name, no registration/ACK edits. */
    async recreate() {
      const before = await incarnation();
      await config.search.request('DELETE', `/${physicalTarget}`);
      await createSubjectIndex(config.search, prefix, 1);
      const after = await incarnation();
      expect(after).not.toBe(before);
      return { before, after };
    },
    close() {
      return (closed ??= (async () => {
        next?.release();
        next = undefined;
        for (const gate of held) gate.release();
        try {
          await operations.close();
        } finally {
          await config.search.request('DELETE', `/${physicalTarget}`);
        }
      })());
    },
  };
}
export type PublicFilterConsumerFixture = Awaited<ReturnType<typeof createPublicFilterConsumerFixture>>;
