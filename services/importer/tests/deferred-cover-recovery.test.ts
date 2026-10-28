import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer, type ImportMediaResolver } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { RunStore } from '../src/run-store.ts';
import { RecordBindings } from '../src/record-bindings.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const raw = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/bangumi/subject.json'), 'utf8'),
);
const registration = createSourceRegistration('bangumi');
const owner = { source: registration.source, external_id: String(raw.id) };
async function* input(changed = false) {
  const payload = structuredClone(raw);
  if (changed) {
    payload.name = 'Replacement observatory';
    payload.images.large = 'https://lain.bgm.tv/pic/cover/l/ab/cd/replacement.jpg';
  }
  yield { source: 'bangumi' as const, key: owner.external_id, revision: null, payload };
}
const isCover = (c: BatchCommand) => c.op !== 'create' && c.source.field_group === 'cover';

// Only public transport and provider availability are fake; receipts survive SQLite reopen.
function remote() {
  type Result = BatchWriteResult['results'][number];
  const receipts = new Map<string, { bytes: string; result: Result }>();
  const live = new Map<string, BatchCommand>();
  const requests: BatchWriteRequest[] = [],
    effects: BatchCommand[] = [];
  const media = new Map<string, { bytes: string; id: string }>();
  const availability: boolean[] = [];
  const transport = {
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      return {
        results: request.commands.map((command) => {
          const bytes = JSON.stringify(command),
            prior = receipts.get(command.key);
          if (prior) {
            expect(bytes).toBe(prior.bytes);
            return structuredClone(prior.result);
          }
          let value: { revision: number; id?: string; candidate?: string } = { revision: 1 };
          if (command.op === 'create') value = { id: randomUUID(), revision: 1 };
          else if (command.op === 'propose') {
            const candidate = randomUUID();
            live.set(candidate, structuredClone(command));
            value = { candidate, revision: 1 };
          } else {
            expect(live.has(command.candidate)).toBe(true);
            live.delete(command.candidate);
          }
          const result = { key: command.key, status: 200 as const, value } as Result;
          receipts.set(command.key, { bytes, result: structuredClone(result) });
          effects.push(structuredClone(command));
          return result;
        }),
      };
    },
  };
  const mediaResolver: ImportMediaResolver = {
    async resolve({ mediaImportIntents, deferPending }) {
      availability.push(!!deferPending);
      if (deferPending) return { status: 'pending' };
      const mediaIds: Record<string, string> = {};
      for (const intent of mediaImportIntents) {
        const bytes = JSON.stringify(intent);
        let receipt = media.get(intent.sourceUrl);
        if (receipt) expect(bytes).toBe(receipt.bytes);
        else {
          receipt = { bytes, id: randomUUID() };
          media.set(intent.sourceUrl, receipt);
        }
        mediaIds[intent.sourceUrl] = receipt.id;
      }
      return { status: 'available', mediaIds };
    },
  };
  const liveCovers = () =>
    [...live]
      .filter(([, c]) => isCover(c))
      .map(([id]) => id)
      .sort();
  return { transport, mediaResolver, receipts, requests, effects, media, availability, liveCovers };
}

for (const scenario of [
  'normal',
  'before acknowledgement',
  'after acknowledgement',
  'changed after acknowledgement',
] as const) {
  test(`deferred cover survives ${scenario} and same-input replay`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'deferred-cover-'));
    const path = join(directory, 'state.sqlite'),
      f = remote(),
      controller = new AbortController();
    let armed = false,
      faults = 0,
      candidate = '';
    let proposal: BatchCommand | undefined;
    let importer = new Importer({
      path,
      transport: f.transport,
      mediaResolver: f.mediaResolver,
      afterBulkSuccess(request, response) {
        if (armed && scenario === 'before acknowledgement' && request.commands.some(isCover)) {
          const index = request.commands.findIndex((c) => isCover(c) && c.op === 'propose');
          proposal = structuredClone(request.commands[index]!);
          const result = response.results[index]!;
          if (!('value' in result) || !('candidate' in result.value)) throw new Error('Missing cover receipt');
          candidate = result.value.candidate;
          armed = false;
          faults++;
          throw new Error('Test crash after remote cover success');
        }
      },
    });
    const original = RunStore.prototype.resolveDeferredCover;
    try {
      expect(importer.session).toBeInstanceOf(ImportSession);
      expect(importer.session.store).toBeInstanceOf(RunStore);
      expect(importer.session.bindings).toBeInstanceOf(RecordBindings);
      const changed = scenario === 'changed after acknowledgement';
      let older: string | undefined;
      let previousGeneration: string | null = null;
      if (changed) {
        expect((await importer.runRecords(registration, input())).status).toBe('committed');
        expect(f.liveCovers()).toHaveLength(1);
        older = f.liveCovers()[0]!;
        previousGeneration = importer.session.store.source(owner.source).generation;
      }
      armed = scenario !== 'normal';
      if (scenario.endsWith('after acknowledgement')) {
        RunStore.prototype.resolveDeferredCover = function (...args) {
          if (this === importer.session.store && armed) {
            const bound = importer.session.bindings.candidates(owner, 'cover', { limit: 100 });
            expect(bound).toHaveLength(1);
            candidate = bound[0]!.candidate;
            proposal = JSON.parse(bound[0]!.bytes).commands[0];
            expect(f.liveCovers()).toEqual([candidate]);
            armed = false;
            faults++;
            controller.abort();
            throw new Error('Test crash before clearing deferred cover');
          }
          return original.apply(this, args);
        };
      }
      const first = await importer.runRecords(registration, input(changed), { signal: controller.signal });
      RunStore.prototype.resolveDeferredCover = original;
      if (scenario === 'normal') {
        expect(first.status).toBe('committed');
        const bound = importer.session.bindings.candidates(owner, 'cover', { limit: 100 });
        expect(bound).toHaveLength(1);
        candidate = bound[0]!.candidate;
        proposal = JSON.parse(bound[0]!.bytes).commands[0];
        expect(faults).toBe(0);
      } else {
        expect(first.status).toBe('interrupted');
        expect(faults).toBe(1);
        expect(importer.session.store.source(owner.source).generation).toBe(previousGeneration);
        expect(importer.session.bindings.candidates(owner, 'cover', { limit: 100 }).map((c) => c.candidate)).toEqual(
          scenario === 'before acknowledgement' ? [] : [candidate],
        );
      }
      if (!proposal) throw new Error('Missing original cover proposal');
      expect(proposal.op).toBe('propose');
      expect(f.liveCovers()).toEqual([candidate]);
      expect(f.media.size).toBe(changed ? 2 : 1);
      expect(f.availability.slice(changed ? 2 : 0)).toEqual([true, false]);
      if (older) expect(f.effects.filter((c) => c.op === 'retract' && c.candidate === older)).toHaveLength(1);
      const mediaEffects = f.media.size;
      await importer.close();
      importer = new Importer({ path, transport: f.transport, mediaResolver: f.mediaResolver });
      expect((await importer.runRecords(registration, input(changed))).status).toBe('committed');
      const bound = importer.session.bindings.candidates(owner, 'cover', { limit: 100 });
      const observations = {
        live: f.liveCovers(),
        bound: bound.map((c) => c.candidate),
        proposal: bound.map((c) => JSON.parse(c.bytes).commands[0]),
        retractions: f.requests
          .flatMap((r) => r.commands)
          .filter((c) => c.op === 'retract' && c.candidate === candidate),
        proposalEffects: f.effects.filter((c) => c.key === proposal!.key),
        mediaEffects: f.media.size,
      };
      expect(importer.session.store.source(owner.source).count).toBe(1);
      expect(importer.session.store.source(owner.source).generation).not.toBeNull();
      const state = importer.session.store.key(owner.source, owner.external_id);
      expect(state.baseline).toEqual(state.acknowledged);
      expect(state.baseline?.state).toBe('present');
      const requests = f.requests.length,
        effects = f.effects.length,
        availability = f.availability.length;
      expect((await importer.runRecords(registration, input(changed))).status).toBe('committed');
      expect(f.requests.length).toBe(requests);
      expect(f.effects.length).toBe(effects);
      expect(f.availability.length).toBe(availability);
      expect(f.media.size).toBe(mediaEffects);
      expect(observations).toEqual({
        live: [candidate],
        bound: [candidate],
        proposal: [proposal],
        retractions: [],
        proposalEffects: [proposal],
        mediaEffects,
      });
      expect(f.liveCovers()).toEqual([candidate]);
    } finally {
      RunStore.prototype.resolveDeferredCover = original;
      await importer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
