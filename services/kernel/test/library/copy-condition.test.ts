import { expect, test } from 'bun:test';
import {
  COPY_CONDITION_CHOICES,
  copyConditionAdmission,
  mergeCopyConditionFields,
  parseCopyConditionFields,
  presentCopyCondition,
} from '../../src/library/copy-condition.ts';
import type { LibraryCopyKindDescriptor, LibraryProfilePin } from '../../src/library/profile.ts';

// Structural supplier fixture, not a claim that Definitions currently publishes this capability.
const physical = {
  id: 'physical',
  labels: { en: 'Physical copy' },
  statuses: [],
  condition: 'physical-v1',
} satisfies LibraryCopyKindDescriptor;
const pin: LibraryProfilePin = {
  provenance: 'profile',
  releaseDigest: 'accepted',
  acceptingType: 'ex:Release',
  profileId: 'holdings',
};
const acceptance = { kind: physical, pin };

test('two copies preserve independent media, packaging and original field acceptance', () => {
  const first = mergeCopyConditionFields({}, { mediaCondition: 'mint', packagingCondition: 'poor' }, acceptance);
  const second = mergeCopyConditionFields({}, { mediaCondition: 'unknown' }, acceptance);
  const edited = mergeCopyConditionFields(
    first,
    { packagingCondition: null },
    {
      kind: physical,
      pin: { ...pin, releaseDigest: 'later' },
    },
  );
  expect(first.mediaCondition?.value).toBe('mint');
  expect(first.packagingCondition?.value).toBe('poor');
  expect(edited.mediaCondition).toBe(first.mediaCondition);
  expect(edited.packagingCondition).toMatchObject({ value: null, pin: { releaseDigest: 'later' } });
  expect(presentCopyCondition(second.mediaCondition, physical)).toEqual({
    state: 'recorded',
    id: 'unknown',
    label: 'Unknown',
  });
  expect(presentCopyCondition(second.packagingCondition, physical)).toEqual({ state: 'not_recorded' });
  expect(presentCopyCondition(edited.packagingCondition, physical)).toEqual({ state: 'cleared' });
  expect(presentCopyCondition(first.mediaCondition, null)).toEqual({ state: 'unavailable' });
});

test('old command operands remain absent and exact retries retain clear versus unknown', () => {
  expect(parseCopyConditionFields({ revision: 4, note: 'Existing intent' })).toEqual({});
  const input = { mediaCondition: null, packagingCondition: 'unknown' } as const;
  expect(parseCopyConditionFields(JSON.parse(JSON.stringify(input)))).toEqual(input);
  for (const field of ['mediaCondition', 'packagingCondition']) {
    for (const value of [undefined, '', 'excellent', 0, false, {}, ['mint']]) {
      expect(() => parseCopyConditionFields({ [field]: value })).toThrow(`Invalid copy field: ${field}`);
    }
    for (const choice of COPY_CONDITION_CHOICES)
      expect(parseCopyConditionFields({ [field]: choice.id })).toEqual({ [field]: choice.id });
  }
});

test('physical labels, digital kinds and missing publication cannot admit writes', () => {
  const unsupported: LibraryCopyKindDescriptor = { id: 'physical', labels: { en: 'Physical' }, statuses: [] };
  expect(copyConditionAdmission(unsupported)).toEqual({ state: 'unavailable', reason: 'unsupported' });
  const future = JSON.parse(JSON.stringify({ ...physical, condition: 'future' }));
  expect(copyConditionAdmission(future)).toEqual({ state: 'unavailable', reason: 'unrecognized_vocabulary' });
  for (const kind of [unsupported, { ...unsupported, id: 'digital' }]) {
    expect(() => mergeCopyConditionFields({}, { mediaCondition: 'mint' }, { kind, pin })).toThrow(
      'Unsupported copy condition capability',
    );
    // Metadata edits need no condition admission and cannot alter retained observations.
    const retained = mergeCopyConditionFields({}, { mediaCondition: 'fair' }, acceptance);
    expect(mergeCopyConditionFields(retained, {}, { kind, pin })).toBe(retained);
    expect(presentCopyCondition(retained.mediaCondition, physical)).toMatchObject({ id: 'fair' });
    expect(presentCopyCondition(retained.mediaCondition, kind)).toEqual({ state: 'unavailable' });
  }
});
