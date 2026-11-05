import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { join } from 'node:path';
import { checkBatchWrite, type BatchWriteRequest } from '@rezics/definitions/bulk';
import type { CommandObservation, CreateImportLedgerDriver } from '../../../specs/imports-ledger-driver.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

/** Only serialization/observation lives here; reconciliation runs in production. */
export const createImportLedgerDriver: CreateImportLedgerDriver = async (options) => {
  const outputs: { raw: unknown; sourceLicensePointer: string }[] = [];
  let interrupt = false;
  const registrations = new Map(['ledger-converter-1', 'ledger-converter-2'].map((revision) => [revision, revision]));
  const importer = new Importer({
    path: join(options.directory, 'imports.sqlite'),
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      batchWrite: (request) => options.bulk.send(request),
      readFence: (tuple) => options.readFence(tuple),
    },
    // This outcome fixture mutates shared fake fence state from response hooks.
    recordConcurrency: 1,
    onConversionOutput(output) {
      outputs.push({ raw: structuredClone(output), sourceLicensePointer: '/sourceMetadata/license' });
    },
    afterBulkSuccess() {
      if (interrupt) {
        interrupt = false;
        throw new Error('Injected interruption at the production acknowledgement boundary');
      }
    },
  });
  return {
    close: () => importer.close(),
    async run(input) {
      const revision = registrations.get(input.converter_revision);
      if (!revision) throw new Error('Unregistered fixture converter revision');
      const registration = createSourceRegistration('wikidata', { source: input.source, converterRevision: revision });
      async function* bytes() {
        const chunks = typeof input.dump === 'string' ? [input.dump] : input.dump;
        for await (const chunk of chunks) yield new TextEncoder().encode(chunk);
      }
      return importer.runDump(registration, bytes(), {
        collectionLimit: 100,
        ...(input.disappearanceThreshold === undefined ? {} : { disappearanceThreshold: input.disappearanceThreshold }),
      });
    },
    async observe(source) {
      const store = importer.session.store;
      const rows = [];
      let after: string | undefined;
      for (;;) {
        const page = store.pageAcknowledged(source, { ...(after ? { after } : {}), limit: 100 });
        rows.push(...page);
        if (page.length < 100) break;
        after = page.at(-1)!.recordKey;
      }
      return { committedSnapshot: store.source(source).generation, rows };
    },
    inspectBulk(input) {
      if (checkBatchWrite(input).length) throw new TypeError('Invalid public batch request');
      const request = JSON.parse(JSON.stringify(input)) as BatchWriteRequest;
      return request.commands.map((command): CommandObservation => {
        const strings = (value: unknown): string[] => {
          if (typeof value === 'string') return [value];
          if (!value || typeof value !== 'object') return [];
          return Object.values(value).flatMap(strings);
        };
        const references =
          command.op === 'create'
            ? []
            : strings(command.op === 'propose' ? command.statement.references : command.references);
        return {
          command,
          kind: command.op,
          idempotencyKey: command.key,
          ...command.source,
          values:
            command.op === 'create'
              ? strings(command.subject)
              : command.op === 'propose'
                ? strings(command.statement.value)
                : [],
          references,
          licenses: command.op === 'propose' && command.rights ? [command.rights.license] : [],
        };
      });
    },
    conversionOutputs: () => outputs,
    interruptNextAfterBulkSuccess() {
      interrupt = true;
    },
  };
};
