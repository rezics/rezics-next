import { checkBatchWrite, type BatchCommand, type BatchReference } from '@rezics/definitions/bulk';
import { parseDocument } from '@rezics/document';
import type {
  BangumiDriver,
  ConversionInspection,
  ProposedField,
  RightsPointers,
} from '../../../specs/imports-bangumi-driver.ts';
import { convertBangumi, type BangumiConversion } from '../src/bangumi.ts';

const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const asset = '/coverAssets/0';
const coverMetadata = '/sourceMetadata/cover';
const coverRights: RightsPointers = {
  envelope: `${asset}/credit`,
  license: `${asset}/credit/license`,
  credit: `${coverMetadata}/creditLine`,
  originalSource: `${asset}/credit/via/url`,
  obligations: `${asset}/credit/obligations`,
  takedownEligible: `${coverMetadata}/takedownEligible`,
};

function output(value: unknown): BangumiConversion {
  if (value === null || typeof value !== 'object' || !('proposals' in value))
    throw new TypeError('Expected converter output');
  if (checkBatchWrite({ commands: value.proposals }).length) throw new TypeError('Invalid portable proposals');
  return value as BangumiConversion;
}

function referencePointers(references: BatchReference[], root: string, recordUrl: string): string[] {
  return references.flatMap((reference, i) =>
    reference.parts.flatMap((part, j) =>
      part.property.id === 'schema:url' && part.value.type === 'value' && part.value.content === recordUrl
        ? [`${root}/${i}/parts/${j}/value/content`]
        : [],
    ),
  );
}

export function createBangumiDriver(): BangumiDriver {
  return {
    convert(input, context) {
      return convertBangumi(
        { external_id: input.externalId, record_revision: input.recordRevision, record: input.record },
        context,
      );
    },
    inspect(value): ConversionInspection {
      const actual = output(value);
      const fields: ProposedField[] = [];
      const commands = actual.proposals.map((_, i) => `/proposals/${i}`);
      actual.proposals.forEach((command, i) => {
        const root = commands[i]!;
        const common = { command: root, fieldGroup: `${root}/source/field_group` };
        if (command.op === 'create') {
          if (Object.prototype.hasOwnProperty.call(command.subject, 'statements'))
            throw new TypeError('Bootstrap must contain metadata only');
          fields.push({ ...common, role: 'type', value: `${root}/subject/type`, references: [] });
          for (const language of Object.keys(command.subject.labels)) {
            fields.push({
              ...common,
              role: language === 'zh' ? 'chinese-label' : 'title',
              value: `${root}/subject/labels/${escape(language)}`,
              references: [],
            });
          }
          return;
        }
        if (command.op !== 'propose') return;
        const statement = command.statement;
        const references = referencePointers(
          statement.references,
          `${root}/statement/references`,
          actual.sourceMetadata.recordUrl,
        );
        const content = statement.value.type === 'value' ? statement.value.content : undefined;
        if (statement.property.id === 'schema:name') {
          const title = content as { language: string };
          fields.push({
            ...common,
            role: title.language === 'zh' ? 'chinese-label' : 'title',
            value: `${root}/statement/value/content/text`,
            references,
          });
        } else if (statement.property.id === 'schema:abstract') {
          // The actual document codec validates what the production command carries.
          parseDocument((content as { document: unknown }).document);
          fields.push({
            ...common,
            role: 'summary',
            value: `${root}/statement/value/content`,
            references,
            rights: {
              envelope: `${root}/rights`,
              license: `${root}/rights/license`,
              credit: `${root}/rights/attribution`,
              originalSource: references[0]!,
              obligations: `${root}/rights/obligations`,
              takedownEligible: '/sourceMetadata/summary/takedownEligible',
            },
          });
        } else if (statement.property.id === 'schema:image') {
          fields.push({
            ...common,
            role: 'cover',
            value: `${root}/statement/value/content`,
            references,
            rights: coverRights,
          });
        }
      });
      const intentRoot = actual.mediaImportIntents.length ? '/mediaImportIntents/0' : asset;
      return {
        source: '/source',
        externalId: '/external_id',
        recordRevision: '/record_revision',
        converterRevision: '/converter_revision',
        commands,
        fields,
        coverIntent: {
          sourceUrl: `${intentRoot}/sourceUrl`,
          credit: coverRights.credit,
          provenance: `${intentRoot}/provenance`,
          license: `${intentRoot}/credit/license`,
          role: `${coverMetadata}/role`,
          takedownEligible: coverRights.takedownEligible,
        },
      };
    },
    offer(value, consumer) {
      const actual = output(value);
      for (const command of actual.proposals) consumer.accept(command as BatchCommand);
    },
    close() {},
  };
}
