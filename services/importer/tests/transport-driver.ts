export { createImportTransport } from '../src/import-client.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourceDigest } from '@rezics/conversion/support';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createImportTransport, ImportTransportError, type ReviewedSubjectRead } from '../src/import-client.ts';
import { GLOBAL_CONTEXT } from '../src/public-bulk-client.ts';
import { isImportSourceRecord } from '../src/source-record-runtime.ts';
import {
  type ImportSourceRecordMetadataCommand,
  type ImportSourceRecordMetadataResult,
  type ImportSourceObservationHead,
} from '../src/import-contract.ts';
import { sourceObservation, type SourceObservation } from '../../kernel/src/rating/source-provider.ts';

type ReviewedStatement = ReviewedSubjectRead['subject']['statements'][string][number];

export function reviewedStatementFixture(
  id: string,
  rank: ReviewedStatement['rank'],
  statement: BatchStatement,
): ReviewedStatement {
  const nativeSnak = ({ property, value }: Pick<BatchStatement, 'property' | 'value'>) => ({
    property: { id: property.id, data_type: bundledRelease.properties[property.id]!.datatype },
    value: structuredClone(value),
  });
  return {
    ...nativeSnak(statement),
    id,
    rank,
    qualifiers: (statement.qualifiers ?? []).map(nativeSnak),
    references: statement.references.map(({ parts }) => ({ parts: parts.map(nativeSnak), hash: sourceDigest(parts) })),
    rezics: { release: 'released', revision: 1 },
  };
}

export function reviewedSubjectFixture(
  subject: Pick<ReviewedSubjectRead['subject'], 'id' | 'type' | 'context' | 'labels' | 'statements'>,
): ReviewedSubjectRead {
  return {
    subject: {
      revision: 1,
      release: 'released',
      resolution: {},
      relationCounts: {},
      descriptions: {},
      aliases: {},
      sourceRecords: [],
      ...structuredClone(subject),
    },
    account: null,
    summary: null,
    related: {},
  };
}

/** Current local readback changes only when the fixture explicitly selects a proposal. */
export function reviewedSubjectReadbackFixture() {
  const subjects = new Map<string, ReviewedSubjectRead>();
  const ids = new Map<string, string>();

  return {
    ids,
    created(command: Extract<BatchCommand, { op: 'create' }>, id: string) {
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
    select(command: Extract<BatchCommand, { op: 'propose' }>, candidate: string) {
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

export function reviewedVocabularySubjectFixture(
  id: string,
  type: 'skos:ConceptScheme' | 'skos:Concept',
  uri: string,
  currentValues: Record<string, string>,
): ReviewedSubjectRead {
  return reviewedSubjectFixture({
    id,
    type,
    context: GLOBAL_CONTEXT,
    labels: {},
    statements: Object.fromEntries(
      Object.entries(currentValues).map(([property, content]) => [
        property,
        [
          reviewedStatementFixture(randomUUID(), 'normal', {
            property: { id: property },
            value: { type: 'value', content },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: uri } }] }],
          }),
        ],
      ]),
    ),
  });
}

/** Explicit canonical provider heads for local protocol doubles, including clears. */
export function sourceObservationFixture() {
  const heads = new Map<string, ImportSourceObservationHead>();
  const orders = new Map<string, number>();
  const read = (subjectId: string): ImportSourceObservationHead =>
    heads.get(subjectId) ?? { state: 'empty', digest: null, observation: null };
  const observe = (subjectId: string, value: SourceObservation) => {
    const observed = sourceObservation(subjectId, 'vndb', value);
    if (read(subjectId).digest === observed.digest) return;
    const order = (orders.get(subjectId) ?? 0) + 1;
    orders.set(subjectId, order);
    heads.set(subjectId, {
      state: value.count === 0 ? 'cleared' : 'published',
      digest: observed.digest,
      observation: {
        ...observed,
        payloadVersion: 1,
        sourceAlias: observed.payload.sourceAlias,
        sourceRecordId: value.sourceRecordId,
        asOf: value.asOf,
        nativeOrder: String(order),
        legacy: false,
        provenance: { kind: 'unversioned', digest: observed.digest },
      },
    } as ImportSourceObservationHead);
  };
  const inspect = (subjectId: string) => {
    const head = read(subjectId);
    return {
      source: 'vndb',
      head,
      resolution: {
        put: { expectedObservation: head.digest },
        clear: { expectedObservation: head.digest },
      },
    };
  };
  return { read, observe, inspect };
}

/** Local protocol double only. Real authorization/selection proof uses the kernel API fixture. */
export function sourceRecordMetadataFixture() {
  const records = new Map<string, ImportSourceRecordMetadataResult>();
  const receipts = new Map<string, { bytes: string; result: ImportSourceRecordMetadataResult; status: number }>();
  const requests: { command: ImportSourceRecordMetadataCommand; key: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname !== '/v1/source-records:setMetadata' || request.method !== 'POST')
      throw new Error('Unexpected metadata fixture request');
    const command = (await request.json()) as ImportSourceRecordMetadataCommand;
    const key = JSON.parse(request.headers.get('idempotency-key')!) as string;
    requests.push({ command: structuredClone(command), key });
    if (!isImportSourceRecord(command.metadata)) return Response.json({}, { status: 422 });
    const bytes = JSON.stringify(command);
    const receipt = receipts.get(key);
    if (receipt)
      return receipt.bytes === bytes
        ? Response.json(receipt.result, { status: receipt.status })
        : Response.json({}, { status: 422 });
    const tuple = JSON.stringify([command.source, command.external_id]);
    const previous = records.get(tuple);
    let record = structuredClone(command.metadata);
    const expected = command.expected_metadata_revision;
    if (expected === null && previous) {
      const leaves = (value: typeof record) => ({
        name: value.name,
        url: value.url,
        ...(value.attribution === undefined ? {} : { attribution: value.attribution }),
        ...(value.licence
          ? { id: value.licence.id, ...(value.licence.url ? { licenceUrl: value.licence.url } : {}) }
          : {}),
      });
      const prior = leaves(previous.record),
        next = leaves(record);
      if (Object.entries(next).some(([key, value]) => key in prior && Reflect.get(prior, key) !== value))
        return Response.json({}, { status: 409 });
      record = {
        ...previous.record,
        ...record,
        ...(previous.record.licence || record.licence
          ? { licence: { ...previous.record.licence, ...record.licence } as NonNullable<typeof record.licence> }
          : {}),
      };
    } else if (expected !== null && expected !== previous?.metadata_revision) return Response.json({}, { status: 409 });
    const changed = !isDeepStrictEqual(record, previous?.record);
    const result: ImportSourceRecordMetadataResult = {
      record,
      metadata_revision: (previous?.metadata_revision ?? 0) + (changed ? 1 : 0),
      effect: changed ? (expected === null ? 'filled' : 'corrected') : 'noEffect',
    };
    const status = previous ? 200 : 201;
    if (changed) records.set(tuple, structuredClone(result));
    receipts.set(key, { bytes, result: structuredClone(result), status });
    return Response.json(result, { status, headers: { 'rezics-session-token': 'metadata-session' } });
  }) as typeof globalThis.fetch;
  const transport = createImportTransport({
    origin: 'https://metadata.test',
    tokenProvider: async () => 'local-fixture',
    fetch,
  });
  return { records, receipts, requests, fetch, setSourceRecordMetadata: transport.setSourceRecordMetadata };
}
