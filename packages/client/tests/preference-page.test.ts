import { expect, test } from 'bun:test';
import {
  decodePreferenceAdvice,
  decodePreferencePage,
  decodePreferenceValues,
} from '../src/preference-page.ts';

const values = { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 4, shelf: {}, notifications: { reply: true } };
const envelope = {
  ...values,
  viewerState: 'current' as const,
  allowedActions: { read: { allowed: true as const }, update: { allowed: true as const } },
  reading: {
    supported: { spoilerLevels: [0, 1, 2] as (0 | 1 | 2)[], suitability: ['blur', 'show'] as ('blur' | 'show')[] },
    effective: { spoilerLevel: 1 as const, suitability: 'blur' as const },
    defaults: { spoilerLevel: 0 as const, suitability: 'blur' as const },
  },
};

test('a complete native preference page decodes values, supported choices and owner actions', () => {
  expect(decodePreferencePage(envelope)).toEqual(envelope);
  expect(decodePreferenceValues(envelope)).toMatchObject(values);
});

test('malformed choice data is unavailable rather than a guessed enum', () => {
  for (const broken of [
    { ...envelope, reading: { ...envelope.reading, supported: { spoilerLevels: [0, 1, 3], suitability: ['blur', 'show'] } } },
    { ...envelope, reading: { ...envelope.reading, supported: { spoilerLevels: [0, 1, 2], suitability: ['hide'] } } },
    { ...envelope, reading: { ...envelope.reading, supported: { spoilerLevels: [1, 1], suitability: ['blur'] } } },
    { ...envelope, reading: { ...envelope.reading, effective: { spoilerLevel: 3, suitability: 'blur' } } },
    { ...envelope, viewerState: 'signed_in' },
    { ...envelope, allowedActions: { read: { allowed: true }, update: { allowed: true, reason: 'not_authorized' } } },
    { ...envelope, reading: { ...envelope.reading, defaults: { spoilerLevel: 1, suitability: 'blur' } } },
  ])
    expect(decodePreferenceAdvice(broken)).toBeUndefined();
  expect(decodePreferenceValues({ spoilerLevel: 3, suitability: 'blur', version: 1 })).toBeUndefined();
  expect(decodePreferenceValues(values)).toMatchObject(values);
  expect(decodePreferencePage({ ...envelope, spoilerLevel: 2 })).toBeUndefined();
  expect(
    decodePreferencePage({
      ...envelope,
      reading: { ...envelope.reading, effective: { spoilerLevel: 2, suitability: 'blur' } },
    }),
  ).toBeUndefined();
});

test('a readable owner whose edit is disallowed remains a current viewer', () => {
  const denied = {
    ...envelope,
    allowedActions: { read: { allowed: true as const }, update: { allowed: false as const, reason: 'not_authorized' as const } },
  };
  const page = decodePreferencePage(denied);
  expect(page?.viewerState).toBe('current');
  expect(page?.allowedActions.update).toEqual({ allowed: false, reason: 'not_authorized' });
  expect(page?.reading.defaults).toEqual({ spoilerLevel: 0, suitability: 'blur' });
});
