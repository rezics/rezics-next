import { checkBatchWrite, type BatchCommand, type BatchStatement } from '@rezics/definitions/bulk';
import { parseDocument } from '@rezics/document';
import type { FactObservation, Path, VndbDriver } from '../../../specs/imports-vndb-driver.ts';
import { converter_revision, convertVndb } from '../src/vndb.ts';

function parseProposal(proposal: unknown): BatchCommand {
  if (checkBatchWrite({ commands: [proposal] }).length) throw new Error('Invalid portable batch proposal');
  return proposal as BatchCommand;
}

export function bindVndbDriver(): VndbDriver {
  return {
    converter_revision,
    convert(record, context) {
      // Mechanical envelope only: no default subject, source mappings or source rewriting.
      const grouped = record as { vn?: { id?: string }; entry_meta?: { revision?: unknown } } | null;
      return convertVndb(
        {
          external_id: grouped?.vn?.id as string,
          record_revision:
            grouped?.entry_meta?.revision === undefined ? 'unversioned' : String(grouped.entry_meta.revision),
          record,
        },
        context,
      );
    },
    locate(output) {
      const actual = output as ReturnType<typeof convertVndb>;
      return {
        proposals: actual.proposals.map((_, i) => ['proposals', i]),
        converterRevision: ['converter_revision'],
        sourceRights: {
          databaseLicense: ['sourceMetadata', 'databaseLicense'],
          contentsLicense: ['sourceMetadata', 'contentsLicense'],
          attribution: ['sourceMetadata', 'attribution'],
        },
      };
    },
    parseProposal,
    observe(proposal) {
      const actual = parseProposal(proposal);
      const facts: FactObservation[] = [];
      const observeStatement = (entry: BatchStatement, path: Path) => {
        const property = entry.property.id;
        const content = entry.value.type === 'value' ? entry.value.content : undefined;
        let value = content;
        let valuePath: Path = [...path, 'value', 'content'];
        let language: string | undefined;
        let kind: FactObservation['kind'] = 'other';
        if (property === 'schema:name') {
          kind = 'title';
          const title = content as { language: string; text: string };
          language = title.language;
          value = title.text;
          valuePath = [...valuePath, 'text'];
        } else if (property === 'wdt:P3180') kind = 'external-id';
        else if (property === 'schema:image') kind = 'cover';
        else if (property === 'schema:abstract') {
          kind = 'description';
          const summary = content as { language: string; document: object };
          // The actual document decoder is the only interpretation of any emitted snapshot.
          parseDocument(summary.document);
          language = summary.language;
        }
        const urlIndex = entry.references[0]!.parts.findIndex((part) => part.property.id === 'schema:url');
        facts.push({
          kind,
          value,
          valuePath,
          ...(language === undefined ? {} : { language }),
          fieldGroupPath: ['source', 'field_group'],
          reference: {
            source: ['source', 'source'],
            externalId: ['source', 'external_id'],
            revision: ['source', 'record_revision'],
            url: [...path, 'references', 0, 'parts', urlIndex, 'value', 'content'],
          },
        });
      };
      if (actual.op === 'create') {
        if (Object.prototype.hasOwnProperty.call(actual.subject, 'statements'))
          throw new Error('VNDB bootstrap must not include statements');
        return facts;
      }
      if (actual.op === 'propose') observeStatement(actual.statement, ['statement']);
      return facts;
    },
  };
}
