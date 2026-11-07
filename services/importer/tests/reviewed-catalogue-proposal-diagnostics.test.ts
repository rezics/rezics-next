import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { BatchWriteResult } from '@rezics/definitions/bulk';
import { ImportSession } from '../src/import-session.ts';
import { ImportTransportError } from '../src/import-client.ts';
import {
  formatReviewedCatalogueCommandError,
  formatReviewedCatalogueSeedError,
  reviewedCatalogueProblem,
  ReviewedCatalogueCommandError,
  throwReviewedCatalogueBatchFailure,
} from '../src/reviewed-catalogue-contract.ts';
import { writeReviewedCatalogueSeedFailure } from '../src/reviewed-catalogue-cli.ts';
import { reviewedCatalogueOwner, seedReviewedCatalogue } from '../src/reviewed-catalogue.ts';
import type { ReviewedCataloguePort } from '../src/reviewed-catalogue.ts';
import { releasedReviewedVocabulary } from '../src/reviewed-vocabulary-port.ts';

const scheme = 'https://rezics.com/schemes/bangumi/public-tags';

test('RFC9457 catalogue problems keep code, correlation, operation, partition and phase without bodies', () => {
  const problem = reviewedCatalogueProblem({
    type: 'https://rezics.com/problems/transaction_retry_exhausted',
    title: 'Transaction Retry Exhausted',
    status: 503,
    code: 'transaction_retry_exhausted',
    retryable: true,
    request_id: '019a1b2c-3d4e-7f00-8a00-1a0000000099',
    operation: 'statement:propose',
    partition: 12,
    phase: 'transaction_body',
    contention_retries: 0,
    detail: 'private remote diagnostic',
    errors: [{ pointer: '/statement', code: 'unsupported' }],
  });
  expect(problem).toEqual({
    type: 'https://rezics.com/problems/transaction_retry_exhausted',
    status: 503,
    code: 'transaction_retry_exhausted',
    retryable: true,
    request_id: '019a1b2c-3d4e-7f00-8a00-1a0000000099',
    operation: 'statement:propose',
    partition: 12,
    phase: 'transaction_body',
    contention_retries: 0,
  });
  const error = new ReviewedCatalogueCommandError('bangumi-episode-type-1', 'proposal', problem);
  const printed = formatReviewedCatalogueCommandError(error);
  expect(printed).toContain('problem=transaction_retry_exhausted');
  expect(printed).toContain('correlation=019a1b2c-3d4e-7f00-8a00-1a0000000099');
  expect(printed).toContain('seed=bangumi-episode-type-1');
  expect(printed).toContain('operation=statement:propose');
  expect(printed).toContain('partition=12');
  expect(printed).toContain('transaction_phase=transaction_body');
  expect(printed).not.toContain('private remote diagnostic');
  expect(JSON.stringify(error)).not.toContain('private remote diagnostic');
});

test('a retryable proposal 503 keeps sealed journal bytes and does not ACK', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'reviewed-proposal-503-'));
  const unused = async (): Promise<never> => {
    throw new Error('Review preceded proposal delivery');
  };
  const sent: string[] = [];
  const port: ReviewedCataloguePort = {
    readReviewedSubject: unused,
    reviewedCandidates: unused,
    acceptReviewedCandidate: unused,
    adoptReviewedCandidates: unused,
    fence: async () => ({ fenced: false, securityRevision: null }),
    setSourceRecordMetadata: async ({ command }) => ({
      record: command.metadata,
      metadata_revision: 1,
      effect: 'filled',
    }),
    batch: async ({ commands }) => {
      const command = commands[0]!;
      sent.push(JSON.stringify(command));
      if (command.op === 'create')
        return {
          results: [{ key: command.key, status: 201 as const, value: { id: crypto.randomUUID(), revision: 1 } }],
        };
      return {
        results: [
          {
            key: command.key,
            status: 503,
            problem: {
              type: 'https://rezics.com/problems/transaction_retry_exhausted',
              title: 'Transaction Retry Exhausted',
              status: 503,
              code: 'transaction_retry_exhausted',
              retryable: true,
              request_id: 'req-catalogue-1',
              operation: 'statement:propose',
              partition: 3,
              phase: 'commit',
              detail: 'sql state 40001',
            },
          },
        ],
      };
    },
  };
  const path = resolve(directory, 'state.sqlite');
  try {
    const failure = await seedReviewedCatalogue({ path, port }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewedCatalogueCommandError);
    const error = failure as ReviewedCatalogueCommandError;
    expect(error.code).toBe('transaction_retry_exhausted');
    expect(error.correlationId).toBe('req-catalogue-1');
    expect(error.operationName).toBe('statement:propose');
    expect(error.partition).toBe(3);
    expect(error.transactionPhase).toBe('commit');
    expect(error.seedKey).toBe('source-scheme');
    expect(JSON.stringify(error)).not.toContain('sql state 40001');
    const owner = reviewedCatalogueOwner(scheme, '');
    const proposal = JSON.parse(sent.at(-1)!) as { key: string };
    const session = new ImportSession(path);
    try {
      expect(session.bindings.claim(owner)).toMatchObject({ state: 'bound' });
      const stored = session.bindings.journal(owner, proposal.key);
      expect(JSON.parse(stored!.bytes)).toEqual({ commands: [proposal] });
      expect(session.bindings.candidates(owner, 'facts', { limit: 100 })).toEqual([]);
    } finally {
      session.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lost proposal reply resumes the sealed bytes and native idempotency prevents duplicate effects', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'reviewed-proposal-lost-reply-'));
  const released = releasedReviewedVocabulary();
  const seed = released.inventory.find((row) => row.key === 'source-scheme')!;
  const vocabulary = { revision: released.revision, inventory: [seed] };
  const proposalBytes: string[] = [];
  const receipts = new Map<string, BatchWriteResult>();
  let proposalEffects = 0;
  const stopAfterProposal = new Error('Stop after the proposal acknowledgement');
  const unused = async (): Promise<never> => {
    throw new Error('Review should stop after the resumed proposal');
  };
  const port: ReviewedCataloguePort = {
    readReviewedSubject: unused,
    reviewedCandidates: async () => {
      throw stopAfterProposal;
    },
    acceptReviewedCandidate: unused,
    adoptReviewedCandidates: unused,
    fence: async () => ({ fenced: false, securityRevision: null }),
    setSourceRecordMetadata: async ({ command }) => ({
      record: command.metadata,
      metadata_revision: 1,
      effect: 'filled',
    }),
    batch: async ({ commands }) => {
      const command = commands[0]!;
      if (command.op === 'create')
        return {
          results: [{ key: command.key, status: 201 as const, value: { id: '019a1b2c-3d4e-7f00-8a00-1a0000000101', revision: 1 } }],
        };
      proposalBytes.push(JSON.stringify({ commands }));
      const prior = receipts.get(command.key);
      if (prior) return prior;
      proposalEffects++;
      const result: BatchWriteResult = {
        results: [{ key: command.key, status: 201, value: { candidate: '019a1b2c-3d4e-7f00-8a00-1a0000000102', revision: 2 } }],
      };
      receipts.set(command.key, result);
      throw new ImportTransportError(undefined, undefined, undefined, true, undefined, undefined, {
        method: 'POST',
        path: '/v1/subjects:batchWrite',
        phase: 'network',
        networkCode: 'ECONNRESET',
      });
    },
  };
  const path = resolve(directory, 'state.sqlite');
  try {
    const first = await seedReviewedCatalogue({ path, port, vocabulary }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ImportTransportError);
    const owner = reviewedCatalogueOwner(scheme, '');
    const firstRequest = JSON.parse(proposalBytes[0]!) as { commands: [{ key: string }] };
    const proposalKey = firstRequest.commands[0]!.key;
    const session = new ImportSession(path);
    try {
      expect(session.bindings.journal(owner, proposalKey)?.bytes).toBe(proposalBytes[0]);
      expect(session.bindings.candidates(owner, 'facts', { limit: 100 })).toEqual([]);
    } finally {
      session.close();
    }

    const second = await seedReviewedCatalogue({ path, port, vocabulary }).catch((error: unknown) => error);
    expect(second).toBe(stopAfterProposal);
    expect(proposalBytes).toHaveLength(2);
    expect(proposalBytes[1]).toBe(proposalBytes[0]);
    expect(proposalEffects).toBe(1);
    const resumed = new ImportSession(path);
    try {
      expect(resumed.bindings.journal(owner, proposalKey)?.bytes).toBe(proposalBytes[0]);
      expect(resumed.bindings.candidates(owner, 'facts', { limit: 100 })).toHaveLength(1);
    } finally {
      resumed.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('operator CLI prints the transport envelope and never problem JSON', () => {
  const error = new ReviewedCatalogueCommandError('bangumi-episode-type-1', 'proposal', {
    status: 503,
    type: 'https://rezics.com/problems/transaction_retry_exhausted',
    code: 'transaction_retry_exhausted',
    retryable: true,
    request_id: 'corr-1',
    operation: 'statement:propose',
    partition: 4,
    phase: 'transaction_body',
  });
  const chunks: string[] = [];
  writeReviewedCatalogueSeedFailure(error, { write: (chunk) => chunks.push(chunk) });
  expect(chunks.join('')).toBe(`${formatReviewedCatalogueSeedError(error)}\n`);
  expect(chunks.join('')).toContain('problem=transaction_retry_exhausted');
  expect(chunks.join('')).not.toContain('{');
});

test('a missing batch result is not a silent success', () => {
  expect(() => throwReviewedCatalogueBatchFailure('source-scheme', 'proposal', { results: [] })).toThrow(TypeError);
});
