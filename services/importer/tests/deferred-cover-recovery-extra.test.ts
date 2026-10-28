import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer, type ImportMediaResolver } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const raw = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/bangumi/subject.json'), 'utf8'),
);
const registration = createSourceRegistration('bangumi');
const owner = { source: registration.source, external_id: String(raw.id) };
const isCover = (command: BatchCommand) => command.op !== 'create' && command.source.field_group === 'cover';

async function* input(changed = false) {
  const payload = structuredClone(raw);
  if (changed) {
    payload.name = 'Replacement observatory';
    payload.images.large = 'https://lain.bgm.tv/pic/cover/l/ab/cd/replacement.jpg';
  }
  yield { source: 'bangumi' as const, key: owner.external_id, revision: null, payload };
}

function remote() {
  type Result = BatchWriteResult['results'][number];
  const receipts = new Map<string, { bytes: string; result: Result }>();
  const live = new Map<string, BatchCommand>();
  const requests: BatchWriteRequest[] = [];
  const effects: BatchCommand[] = [];
  const media = new Map<string, { bytes: string; id: string }>();
  let partialSuccess = false;

  const apply = (command: BatchCommand): Result => {
    const bytes = JSON.stringify(command);
    const prior = receipts.get(command.key);
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
  };

  const transport = {
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      const retract = request.commands.find((command) => isCover(command) && command.op === 'retract');
      const proposal = request.commands.find((command) => isCover(command) && command.op === 'propose');
      if (!partialSuccess && retract && proposal) {
        partialSuccess = true;
        return {
          results: request.commands.map((command) =>
            command === retract
              ? {
                  key: command.key,
                  status: 409,
                  problem: { type: 'conflict', title: 'Temporary fixture failure', status: 409 },
                }
              : apply(command),
          ),
        };
      }
      return { results: request.commands.map(apply) };
    },
  };
  const mediaResolver: ImportMediaResolver = {
    async resolve({ mediaImportIntents, deferPending }) {
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
      .filter(([, command]) => isCover(command))
      .map(([id]) => id)
      .sort();
  return { transport, mediaResolver, requests, effects, media, liveCovers };
}

test('acknowledged cover survives partial success across reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deferred-cover-partial-'));
  const path = join(directory, 'state.sqlite');
  const f = remote();
  let importer = new Importer({ path, transport: f.transport, mediaResolver: f.mediaResolver });
  try {
    expect((await importer.runRecords(registration, input())).status).toBe('committed');
    const older = f.liveCovers()[0]!;
    await importer.close();
    importer = new Importer({
      path,
      transport: f.transport,
      mediaResolver: f.mediaResolver,
      mediaDeadlineMs: 0,
    });
    const firstChanged = await importer.runRecords(registration, input(true));
    expect(firstChanged.status).toBe('bulk-failed');

    const boundAfterPartial = importer.session.bindings.candidates(owner, 'cover', { limit: 100 });
    expect(boundAfterPartial).toHaveLength(2);
    const acknowledged = boundAfterPartial.find((candidate) => candidate.candidate !== older)!;
    const originalProposal = (JSON.parse(acknowledged.bytes) as BatchWriteRequest).commands[0]!;
    expect(originalProposal.op).toBe('propose');
    expect(f.liveCovers()).toEqual([older, acknowledged.candidate].sort());
    const partial = f.requests.find(
      (request) =>
        request.commands.some((command) => isCover(command) && command.op === 'retract' && command.candidate === older) &&
        request.commands.some((command) => isCover(command) && command.op === 'propose'),
    )!;
    expect(partial.commands).toHaveLength(2);

    await importer.close();
    importer = new Importer({ path, transport: f.transport, mediaResolver: f.mediaResolver });
    expect((await importer.runRecords(registration, input(true))).status).toBe('committed');

    const retry = f.requests.at(-1)!;
    expect(retry.commands).toHaveLength(1);
    expect(retry.commands[0]).toMatchObject({ op: 'retract', candidate: older });
    expect(retry.commands.some((command) => command.key === originalProposal.key)).toBe(false);
    expect(
      f.requests.flatMap((request) => request.commands).filter((command) =>
        isCover(command) && command.op === 'retract' && command.candidate === acknowledged.candidate,
      ),
    ).toHaveLength(0);
    expect(f.effects.filter((command) => command.key === originalProposal.key)).toEqual([originalProposal]);
    expect(f.liveCovers()).toEqual([acknowledged.candidate]);
    expect(importer.session.bindings.candidates(owner, 'cover', { limit: 100 }).map((c) => c.candidate)).toEqual([
      acknowledged.candidate,
    ]);
    expect(importer.session.store.key(owner.source, owner.external_id).baseline?.state).toBe('present');
    expect(f.media.size).toBe(2);
  } finally {
    await importer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
