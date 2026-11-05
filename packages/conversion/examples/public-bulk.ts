import { ConversionError, type ConversionInput, type SourceId } from '@rezics/conversion';
import { convertBangumi, converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { convertVndb, converter_revision as vndbRevision } from '@rezics/conversion/vndb';
import { convertOpenLibrary, converter_revision as openLibraryRevision } from '@rezics/conversion/open-library';
import { convertWikidata, converter_revision as wikidataRevision } from '@rezics/conversion/wikidata';
import { checkBatchWriteResult, type BatchWriteRequest, type BatchWriteResult } from '@rezics/definitions/bulk';

type BatchWrite = (request: BatchWriteRequest) => Promise<BatchWriteResult>;

/** One acquired record, two ordinary public writes. Authority and transport belong to the caller. */
export async function publicBulkRecord(
  input: ConversionInput,
  source: SourceId,
  batchWrite: BatchWrite,
  registration: string = source,
) {
  // Select only actual public exports and their matching revisions, independently of source-body fields.
  const selected = (() => {
    switch (source) {
      case 'bangumi':
        return { convert: convertBangumi, revision: bangumiRevision };
      case 'vndb':
        return { convert: convertVndb, revision: vndbRevision };
      case 'openlibrary':
        return { convert: convertOpenLibrary, revision: openLibraryRevision };
      case 'wikidata':
        return { convert: convertWikidata, revision: wikidataRevision };
      default:
        throw new ConversionError('unsupported_source', '/source');
    }
  })();
  const options = { converterRevision: selected.revision };
  const bootstrap = selected.convert(input, { source: registration }, options);
  if ('outcome' in bootstrap && bootstrap.outcome === 'ignored') {
    return { outcome: 'ignored' as const, bootstrap };
  }
  const create = bootstrap.proposals[0];
  if (bootstrap.proposals.length !== 1 || create?.op !== 'create') {
    throw new ConversionError('expected_bootstrap_create', '/proposals');
  }
  // Seal the sanitized native input before any caller-controlled transport can run.
  const normalized: ConversionInput = {
    external_id: bootstrap.external_id,
    record_revision: bootstrap.record_revision,
    record: structuredClone(bootstrap.normalizedRecord),
  };
  const createKey = create.key;
  const createResponse = await batchWrite({ commands: [create] });
  if (checkBatchWriteResult(createResponse).length || createResponse.results.length !== 1) {
    throw new ConversionError('invalid_create_result', '/results');
  }
  const result = createResponse.results[0]!;
  if (
    result.key !== createKey ||
    (result.status !== 200 && result.status !== 201) ||
    !('value' in result) ||
    !('id' in result.value)
  ) {
    throw new ConversionError('invalid_create_identity', '/results/0');
  }
  const subjectId = result.value.id;
  const bound = selected.convert(normalized, { source: registration, subjectId }, options);
  const proposalResponse = await batchWrite({ commands: [...bound.proposals] });
  // Submitted is not an adoption or an assertion that every proposal succeeded. Inspect the public results.
  return { outcome: 'submitted' as const, bootstrap, createResponse, subjectId, bound, proposalResponse };
}
