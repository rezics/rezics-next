import { expect,test } from 'bun:test';
import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import { uuidToSid } from '@rezics/model/address/sid';

test('VIEW01: claims normalize ASCII case and share one digest per normalized slug',() => {
  expect(normalizeAddressAlias('Tide-Maps','unicode-title').key).toBe(normalizeAddressAlias('tide-maps','unicode-title').key);
  expect(normalizeAddressAlias('Cafe\u0301 Au Lait','unicode-title').key).toBe('café-au-lait');
  expect(normalizeAddressAlias('日本語の作品','unicode-title').key).toBe('日本語の作品');
  for (const value of ['', 'pаypal','LatinΕλληνικά','has/slash','x'.repeat(121),'hidden\u200bkey'])
    expect(() => normalizeAddressAlias(value,'unicode-title')).toThrow();
});

test('VIEW01: a UUID-shaped slug is never assigned, since /w/{uuid} always names a Work ID',() => {
  const uuid='0190a5b2-7c3e-7abc-8def-0123456789ab';
  for (const value of [uuid,uuid.toUpperCase(),uuidToSid(uuid),uuidToSid(uuid).toLowerCase(),uuidToSid(uuid).toUpperCase()])
    expect(() => normalizeAddressAlias(value,'unicode-title')).toThrow('Identity keys cannot be aliases');
});
