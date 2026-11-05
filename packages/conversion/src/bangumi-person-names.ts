import { types as utilTypes } from 'node:util';

export const bangumiPersonNameLimits = Object.freeze({
  maxRecordBytes: 65_536,
  maxInfoboxEntries: 64,
  maxScalarBytes: 4096,
  maxScalarCodepoints: 500,
  maxDiagnostics: 16,
});

export type BangumiPersonNameDiagnostic = { pointer: string; code: string };
export type BangumiPersonNameProjection = {
  chineseName?: string;
  diagnostics: BangumiPersonNameDiagnostic[];
};

type Scalar = { status: 'absent' } | { status: 'valid'; value: string } | { status: 'invalid' };

function plainRecord(value: unknown): value is object {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function member(record: object, key: string): { present: boolean; value?: unknown; valid: boolean } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, valid: true };
  if (!descriptor.enumerable || !('value' in descriptor)) return { present: true, valid: false };
  return { present: true, value: descriptor.value, valid: true };
}

function scalar(value: unknown, present: boolean): Scalar {
  if (!present) return { status: 'absent' };
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim().length === 0 ||
    [...value].length > bangumiPersonNameLimits.maxScalarCodepoints ||
    Buffer.byteLength(value, 'utf8') > bangumiPersonNameLimits.maxScalarBytes ||
    /\p{Cc}/u.test(value)
  )
    return { status: 'invalid' };
  return { status: 'valid', value };
}

/** Inspect only PersonDetail's exact parsed Chinese-name key, one entry level deep. */
export function projectBangumiPersonName(
  nameCn: unknown,
  nameCnPresent: boolean,
  infobox: unknown,
  infoboxPresent = infobox !== undefined,
  recordBytes?: number,
): BangumiPersonNameProjection {
  const diagnostics: BangumiPersonNameDiagnostic[] = [];
  const add = (pointer: string, code: string) => {
    if (diagnostics.length < bangumiPersonNameLimits.maxDiagnostics) diagnostics.push({ pointer, code });
  };
  if (
    recordBytes !== undefined &&
    (!Number.isSafeInteger(recordBytes) || recordBytes < 0 || recordBytes > bangumiPersonNameLimits.maxRecordBytes)
  ) {
    add('/infobox', 'person_detail_record_byte_limit');
    return { diagnostics };
  }
  const topLevel = scalar(nameCn, nameCnPresent);
  if (topLevel.status === 'invalid') add('/name_cn', 'invalid_source_name');

  let infoboxName: string | undefined;
  let infoboxAmbiguous = false;
  if (infoboxPresent) {
    if (utilTypes.isProxy(infobox) || !Array.isArray(infobox) || Object.getPrototypeOf(infobox) !== Array.prototype) {
      add('/infobox', 'invalid_infobox_type');
    } else {
      const length = Object.getOwnPropertyDescriptor(infobox, 'length')?.value;
      if (typeof length !== 'number' || length > bangumiPersonNameLimits.maxInfoboxEntries) {
        add('/infobox', 'infobox_entry_limit');
      } else {
        let matches = 0;
        let malformedMatches = 0;
        for (let index = 0; index < length; index++) {
          const rowDescriptor = Object.getOwnPropertyDescriptor(infobox, String(index));
          if (!rowDescriptor || !rowDescriptor.enumerable || !('value' in rowDescriptor)) {
            add(`/infobox/${index}`, 'malformed_infobox_entry');
            continue;
          }
          const row = rowDescriptor.value;
          if (!plainRecord(row)) {
            add(`/infobox/${index}`, 'malformed_infobox_entry');
            continue;
          }
          const keyMember = member(row, 'key');
          if (!keyMember.valid) {
            add(`/infobox/${index}/key`, 'malformed_infobox_key');
            continue;
          }
          if (keyMember.value !== '简体中文名') continue;

          matches++;
          const valueMember = member(row, 'value');
          if (!valueMember.present || !valueMember.valid) {
            add(`/infobox/${index}/value`, 'malformed_source_name');
            malformedMatches++;
            continue;
          }
          const candidate = scalar(valueMember.value, true);
          if (candidate.status !== 'valid') {
            add(`/infobox/${index}/value`, 'invalid_source_name');
            malformedMatches++;
            continue;
          }
          if (infoboxName === undefined) infoboxName = candidate.value;
          else if (infoboxName !== candidate.value) {
            add(`/infobox/${index}/value`, 'conflicting_source_name');
            infoboxAmbiguous = true;
          }
        }
        if (matches > 1 && malformedMatches > 0) infoboxAmbiguous = true;
        if (matches > 1 && !infoboxAmbiguous) add('/infobox', 'duplicate_source_name_reconciled');
      }
    }
  }

  const top = topLevel.status === 'valid' ? topLevel.value : undefined;
  if (top !== undefined && infoboxName !== undefined && top !== infoboxName) {
    add('/name_cn', 'conflicting_source_name');
    return { diagnostics };
  }
  if (infoboxAmbiguous) return { diagnostics };
  const chineseName = top ?? infoboxName;
  return { ...(chineseName === undefined ? {} : { chineseName }), diagnostics };
}
