import { checkBatchWrite, type BatchCommand, type BatchReference } from '@rezics/definitions/bulk';
import type { WikidataDriver, WikidataObservation, ProposalPointers } from '../../../specs/imports-wikidata-driver';
import { ConversionError } from '../src/index';
import { convertWikidata, converter_revision, type WikidataConversion } from '../src/wikidata';

// Bun's spy types omit construct-only members; SQL is replaced by a throwing
// callable in the frozen I/O interception test, so it cannot open a connection.
declare module 'bun:test' {
  function spyOn(object: typeof Bun, key: 'SQL'): import('bun:test').Mock<() => never>;
}

const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
function statementLocations(command: BatchCommand, root: string): { pointer: string; references: BatchReference[] }[] {
  if (command.op === 'propose') return [{ pointer: `${root}/statement`, references: command.statement.references }];
  if (command.op === 'retract') return [];
  return Object.entries(command.subject.statements ?? {}).flatMap(([key, statements]) =>
    statements.map((statement, i) => ({
      pointer: `${root}/subject/statements/${escape(key)}/${i}`,
      references: statement.references,
    })),
  );
}

export function createWikidataDriver(): WikidataDriver {
  return {
    converter_revision,
    convert(entity, resolvedEntities, context) {
      // Mechanical native envelope framing only; source interpretation belongs to convertWikidata.
      const record = entity as { id?: string; lastrevid?: unknown } | null;
      try {
        return convertWikidata(
          {
            external_id: record?.id as string,
            record_revision: record?.lastrevid === undefined ? 'unversioned' : String(record.lastrevid),
            record: entity,
          },
          { ...context, resolvedReferences: resolvedEntities },
        );
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error;
        return error;
      }
    },
    observe(raw): WikidataObservation {
      if (raw instanceof ConversionError)
        return {
          outcome: 'invalid',
          proposals: [],
          diagnostics: [{ pointer: raw.pointer, code: raw.code }],
        };
      const output = raw as WikidataConversion;
      return {
        outcome: output.outcome,
        diagnostics: [...output.diagnostics],
        proposals: output.proposals.map((command, i): ProposalPointers => {
          const root = `/proposals/${i}`;
          const locations = statementLocations(command, root);
          return {
            command: root,
            fieldGroups: [`${root}/source/field_group`],
            statements: locations.map((location) => location.pointer),
            citations: locations.flatMap(({ pointer, references }) =>
              references.map((_, j) => ({
                reference: `${pointer}/references/${j}`,
                source: `${root}/source/source`,
                externalId: `${root}/source/external_id`,
                sourceRevision: `${root}/source/record_revision`,
                license: '/sourceMetadata/license',
                url: `${pointer}/references/0/parts/0/value/content`,
              })),
            ),
            ...(command.op === 'create'
              ? {
                  labels: `${root}/subject/labels`,
                  descriptions: `${root}/subject/descriptions`,
                  aliases: `${root}/subject/aliases`,
                  subjectType: `${root}/subject/type`,
                }
              : {}),
          };
        }),
      };
    },
    accept(command) {
      const errors = checkBatchWrite({ commands: [command] });
      if (errors.length) throw new Error('Portable bulk validator rejected the command');
      const actual = command as BatchCommand;
      const citations =
        actual.op === 'retract'
          ? actual.references
          : statementLocations(actual, '').flatMap((entry) => entry.references);
      return { command: actual, citations };
    },
  };
}
