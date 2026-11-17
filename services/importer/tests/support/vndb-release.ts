import { randomUUID } from 'node:crypto';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import type { CrossMediaPort } from '../../src/cross-media-seed.ts';
import { ImportTransportError, type ReviewedSubjectRead } from '../../src/import-client.ts';
import { GLOBAL_CONTEXT } from '../../src/public-bulk-client.ts';
import { reviewedStatementFixture, reviewedSubjectFixture, sourceRecordMetadataFixture } from '../transport-driver.ts';

type CreatedSubject = Extract<BatchCommand, { op: 'create' }>;
type Proposal = Extract<BatchCommand, { op: 'propose' }>;
type SuccessfulWrite = Extract<BatchWriteResult['results'][number], { status: 200 | 201 }>;

export function vndbReleaseReadbackFixture() {
  const subjects = new Map<string, ReviewedSubjectRead>();
  const ids = new Map<string, string>();

  return {
    ids,
    created(command: CreatedSubject, id: string) {
      ids.set(command.source.external_id, id);
      if (!subjects.has(id)) {
        subjects.set(
          id,
          reviewedSubjectFixture({
            id,
            type: command.subject.type,
            context: GLOBAL_CONTEXT,
            labels: command.subject.labels,
            statements: {},
          }),
        );
      }
    },
    select(command: Proposal, candidate: string) {
      const subject = subjects.get(command.subject)?.subject;
      if (!subject) throw new Error(`Missing fixture subject ${command.subject}`);
      const slot = (subject.statements[command.statement.property.id] ??= []);
      if (!slot.some((statement) => statement.id === candidate))
        slot.push(reviewedStatementFixture(candidate, command.statement.rank ?? 'normal', command.statement));
    },
    async readReviewedSubject(id: string) {
      const read = subjects.get(id);
      if (!read) throw new ImportTransportError(404);
      return structuredClone(read);
    },
  };
}

export function vndbReleasePortFixture() {
  const readback = vndbReleaseReadbackFixture();
  const metadata = sourceRecordMetadataFixture();
  const results = new Map<string, SuccessfulWrite['value']>();

  // Model a reviewed read separately from the write receipt. Only the named
  // properties are selected in the local fixture before current readback.
  function port(commands: BatchCommand[], reviewedProperties = ['wdt:P3180']): CrossMediaPort {
    return {
      async batch(request) {
        commands.push(...request.commands);
        return {
          results: request.commands.map((command) => {
            const previous = results.get(command.key);
            if (previous) return { key: command.key, status: 200 as const, value: previous };
            let value: SuccessfulWrite['value'] = { revision: 1 };
            if (command.op === 'create') {
              const id = randomUUID();
              readback.created(command, id);
              value = { id, revision: 1 };
            } else if (command.op === 'propose') {
              const candidate = randomUUID();
              if (reviewedProperties.includes(command.statement.property.id)) readback.select(command, candidate);
              value = { candidate, revision: 1 };
            }
            results.set(command.key, value);
            return { key: command.key, status: 201 as const, value };
          }),
        };
      },
      setSourceRecordMetadata: metadata.setSourceRecordMetadata,
      async fence() {
        return { fenced: false, securityRevision: null };
      },
      async writeSourceStatistic() {
        throw new Error('No statistic in this authored fixture');
      },
      async clearSourceStatistic() {},
      readReviewedSubject: readback.readReviewedSubject,
    };
  }

  return { ...readback, port };
}
