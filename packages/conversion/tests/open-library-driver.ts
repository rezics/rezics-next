import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { parseDocument } from '@rezics/document';
import { checkTyped } from '../../../services/kernel/src/semantic/rules.ts';
import type { FieldObservation, OpenLibraryDriver } from '../../../specs/imports-open-library-driver.ts';
import { ConversionError } from '../src/index.ts';
import { converter_revision, convertOpenLibrary, type OpenLibraryConversion } from '../src/open-library.ts';

const kinds: Readonly<Record<string, FieldObservation['kind']>> = {
  'wdt:P648': 'identity',
  'schema:name': 'title',
  'schema:author': 'author',
  'schema:exampleOfWork': 'work',
  'schema:isbn': 'isbn13',
  'schema:datePublished': 'publishDate',
  'schema:abstract': 'description',
  'schema:image': 'cover',
};

export function createOpenLibraryDriver(): OpenLibraryDriver {
  // Keep the actual output's type available to the narrow consumer, which only
  // receives its proposals. This is conversion metadata, not a subject model.
  const outputs = new WeakMap<readonly unknown[], OpenLibraryConversion>();
  return {
    converter_revision,
    convert(record, context) {
      try {
        const output = convertOpenLibrary(
          {
            external_id: record.key as string,
            record_revision: record.revision === undefined ? 'unversioned' : String(record.revision),
            record,
          },
          context,
        );
        outputs.set(output.proposals, output);
        return output;
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error;
        return { outcome: 'rejected', converter_revision, proposals: [], reason: error.code };
      }
    },
    inspectMetadata(output) {
      const actual = output as OpenLibraryConversion;
      const assets: ReturnType<OpenLibraryDriver['inspectMetadata']>['assets'] = [];
      if (actual.sourceMetadata.description !== undefined)
        assets.push({
          kind: 'description',
          value: '/sourceMetadata/description/text',
          license: '/sourceMetadata/description/license',
          group: '/sourceMetadata/description/field_group',
        });
      const collection = actual.mediaImportIntents.length ? 'mediaImportIntents' : 'coverAssets';
      actual[collection].forEach((_, i) => {
        const root = `/${collection}/${i}`;
        assets.push({
          kind: 'cover',
          value: `${root}/sourceUrl`,
          license: `${root}/credit/license`,
          group: `${root}/provenance/field_group`,
          credit: `${root}/credit`,
          mediaImportRequest: root,
          provenance: `${root}/provenance`,
          role: '/sourceMetadata/cover/role',
          takedownEligible: '/sourceMetadata/cover/takedownEligible',
        });
      });
      return { bibliographyPermission: '/sourceMetadata/bibliographyPermission', assets };
    },
    consume(proposals) {
      if (checkBatchWrite({ commands: proposals }).length) throw new TypeError('Invalid portable bulk proposals');
      const accepted = proposals as BatchCommand[];
      const output = outputs.get(proposals);
      const fields: FieldObservation[] = [];
      accepted.forEach((command, index) => {
        if (command.op === 'create') {
          if (checkTyped(bundledRelease, bundledDigest, command.subject).violations.length)
            throw new TypeError('Released catalogue rejected bootstrap');
          if (command.subject.statements !== undefined) throw new TypeError('Bootstrap must contain metadata only');
          return;
        }
        if (command.op !== 'propose') throw new TypeError('Unexpected source command');
        const statement = command.statement;
        const id = statement.property.id;
        const kind = kinds[id];
        if (!kind) throw new TypeError('Unobserved source property');
        if (!output) throw new TypeError('Expected actual converter output metadata');
        const type = output.sourceMetadata.subjectType;
        if (!bundledRelease.types[type]?.properties.includes(id)) throw new TypeError('Property not released for type');
        if (command.source.field_group === 'facts') {
          const checked = checkTyped(bundledRelease, bundledDigest, { type, statements: { [id]: [statement] } });
          if (checked.violations.length) throw new TypeError('Released catalogue rejected source statement');
        }
        // checkTyped on this base handles facts; portable bulk owns media and
        // Text envelopes. Decode any actual document instead of making one here.
        if (id === 'schema:abstract' && statement.value.type === 'value')
          parseDocument((statement.value.content as { document: unknown }).document);
        const path = '/statement/references/0';
        const reference = statement.references[0]!;
        const part = (property: string) => {
          const i = reference.parts.findIndex((entry) => entry.property.id === property);
          if (i < 0) throw new TypeError('Missing actual citation part');
          return `${path}/parts/${i}/value/content`;
        };
        const relation = kind === 'author' || kind === 'work';
        const qualifier = relation
          ? statement.qualifiers?.findIndex((entry) => entry.property.id === 'wdt:P648')
          : undefined;
        if (relation && (qualifier === undefined || qualifier < 0)) throw new TypeError('Missing relation identifier');
        fields.push({
          kind,
          command: index,
          valuePath:
            kind === 'identity'
              ? '/source/external_id'
              : relation
                ? '/statement/value'
                : kind === 'title'
                  ? '/statement/value/content/text'
                  : '/statement/value/content',
          groupPath: '/source/field_group',
          reference: {
            path,
            keyPath: part('wdt:P648'),
            urlPath: part('schema:url'),
            revisionPath: part('schema:version'),
            lastModifiedPath: part('schema:dateModified'),
          },
          ...(relation
            ? { statementPath: '/statement', sourceValuePath: `/statement/qualifiers/${qualifier}/value/content` }
            : {}),
        });
      });
      return { accepted, fields };
    },
  };
}
