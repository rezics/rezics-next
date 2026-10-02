import { expect,test } from 'bun:test';
import { normalizeAddressName } from '@rezics/model/address/names';
import { uuidToSid } from '@rezics/model/address/sid';

test('VIEW01: claims normalize ASCII case and share one digest per normalized slug',() => {
  expect(normalizeAddressName('Tide-Maps','unicode-title').key).toBe(normalizeAddressName('tide-maps','unicode-title').key);
  expect(normalizeAddressName('Cafe\u0301 Au Lait','unicode-title').key).toBe('café-au-lait');
  expect(normalizeAddressName('日本語の作品','unicode-title').key).toBe('日本語の作品');
  for (const value of ['', 'pаypal','LatinΕλληνικά','has/slash','x'.repeat(121),'hidden\u200bkey'])
    expect(() => normalizeAddressName(value,'unicode-title')).toThrow();
});

test('VIEW01: a UUID-shaped slug is never assigned, since /w/{uuid} always names a Work ID',() => {
  const uuid='0190a5b2-7c3e-7abc-8def-0123456789ab';
  for (const value of [uuid,uuid.toUpperCase(),uuidToSid(uuid),uuidToSid(uuid).toLowerCase(),uuidToSid(uuid).toUpperCase()])
    expect(() => normalizeAddressName(value,'unicode-title')).toThrow('Identity keys cannot be names');
});
