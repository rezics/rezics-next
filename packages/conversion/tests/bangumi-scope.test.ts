import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as childProcess from 'node:child_process';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { documentText, parseDocument } from '@rezics/document';
import { ConversionError } from '../src/index.ts';
import { convertBangumi, converter_revision } from '../src/bangumi.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const mediaId = '00000000-0000-4000-8000-000000000002';
const image = 'https://lain.bgm.tv/pic/cover/l/scope.jpg';
const privateMarker = 'PRIVATE_SCOPE_USER_CONTENT';
const record = (type: unknown) => ({
  id: 81,
  type,
  name: 'Original title',
  name_cn: '中文标题',
  summary: 'Complete summary.\nFinal sentence.',
  images: { large: image },
  infobox: '{{Infobox animanga\n|image=https://lain.bgm.tv/opaque.jpg\n}}',
  posts: [{ text: privateMarker }],
  user: { email: privateMarker },
  source: privateMarker,
  converter_revision: privateMarker,
});
const input = (type: unknown) => ({ external_id: '81', record_revision: 'native:7', record: record(type) });
const contexts = [{}, { subjectId, mediaIds: { [image]: mediaId } }];

for (const [type, expected] of [
  [1, 'schema:Book'],
  [2, 'schema:TVSeries'],
  [4, 'schema:VideoGame'],
] as const) {
  test(`launch type ${type} retains bootstrap, bound facts, summary rights and published cover`, () => {
    const bootstrap = convertBangumi(input(type));
    expect(bootstrap.proposals).toHaveLength(1);
    expect(bootstrap.proposals[0]).toMatchObject({
      op: 'create',
      subject: { type: expected, labels: { und: 'Original title', zh: '中文标题' } },
    });
    expect(bootstrap.coverAssets).toHaveLength(1);
    expect(bootstrap.mediaImportIntents).toEqual([]);
    const bound = convertBangumi(input(type), contexts[1]);
    expect(checkBatchWrite({ commands: [...bound.proposals] })).toEqual([]);
    expect(bound.proposals).toHaveLength(5);
    const facts = bound.proposals.filter((command) => command.op === 'propose');
    expect(facts).toHaveLength(5);
    for (const command of facts) {
      expect(command.subject).toBe(subjectId);
      expect(command.statement.references?.flatMap((reference) => reference.parts)).toContainEqual({
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://bgm.tv/subject/81' },
      });
      if (command.source.field_group === 'facts') expect(command).not.toHaveProperty('rights');
    }
    expect(
      facts
        .filter((command) => command.statement.property.id === 'schema:name')
        .map((command) => command.statement.value),
    ).toEqual([
      { type: 'value', content: { language: 'und', text: 'Original title' } },
      { type: 'value', content: { language: 'zh', text: '中文标题' } },
    ]);
    const summary = facts.find((command) => command.source.field_group === 'summary')!;
    expect(summary.rights).toEqual({
      license: 'CC-BY-SA-3.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
      attribution: 'Bangumi contributors (https://bgm.tv/subject/81)',
    });
    expect(summary.statement.value).toMatchObject({ type: 'value', content: { language: 'und' } });
    if (summary.statement.value.type !== 'value') throw new Error('Missing summary document');
    expect(documentText(parseDocument((summary.statement.value.content as { document: unknown }).document))).toBe(
      record(type).summary,
    );
    expect(bound.mediaImportIntents).toHaveLength(1);
    expect(bound.mediaImportIntents[0]).toMatchObject({
      sourceUrl: image,
      containerId: subjectId,
      credit: { license: 'LicenseRef-unknown' },
    });
    expect(facts.find((command) => command.source.field_group === 'cover')?.statement.value).toEqual({
      type: 'value',
      content: mediaId,
    });
    expect(JSON.stringify(bound)).not.toContain(privateMarker);
    const opaqueOnly = input(type);
    delete (opaqueOnly.record as Partial<ReturnType<typeof record>>).images;
    const omitted = convertBangumi(opaqueOnly, { subjectId });
    expect(omitted.coverAssets).toEqual([]);
    expect(omitted.mediaImportIntents).toEqual([]);
    expect(omitted.proposals.some((command) => command.source.field_group === 'cover')).toBe(false);
  });
}

for (const type of [3, 6]) {
  test(`excluded type ${type} returns a safe explicit ignored outcome in both phases`, () => {
    for (const context of contexts) {
      const output = convertBangumi(input(type), context);
      expect(output).toHaveProperty('outcome', 'ignored');
      expect(output).toMatchObject({
        source: 'bangumi',
        external_id: '81',
        record_revision: 'native:7',
        converter_revision,
      });
      expect(output.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(output.proposals).toEqual([]);
      expect(output.coverAssets).toEqual([]);
      expect(output.mediaImportIntents).toEqual([]);
      expect(output.diagnostics).toContainEqual({
        pointer: '/type',
        code: expect.stringMatching(/ignored|skipped|unsupported/),
      });
      for (const diagnostic of output.diagnostics) {
        expect(diagnostic.code).toMatch(/^[a-z][a-z0-9_]{0,127}$/);
        expect(diagnostic.pointer.length).toBeLessThanOrEqual(128);
      }
      expect(JSON.stringify(output)).not.toContain(privateMarker);
      expect(convertBangumi({ ...input(type), record: output.normalizedRecord }, context)).toEqual(output);
      expect(convertBangumi({ ...input(type), record_revision: null }, context).record_revision).toBe('unversioned');
    }
  });
}

test('scope correction changes the previous converter revision without prescribing its replacement', () => {
  expect(converter_revision.length).toBeGreaterThan(0);
  expect(converter_revision as string).not.toBe('bangumi@2');
  for (const type of [1, 2, 4, 3, 6]) expect(convertBangumi(input(type)).converter_revision).toBe(converter_revision);
});

test('unknown and invalid types remain errors, including in the bound phase', () => {
  for (const type of [0, 5, 7, -1, 2.5, '3', null, undefined, NaN, Infinity, {}]) {
    for (const context of contexts) {
      expect(() => convertBangumi(input(type), context)).toThrow(ConversionError);
      try {
        convertBangumi(input(type), context);
      } catch (error) {
        expect(error).toMatchObject({ code: 'unsupported_type', pointer: '/type' });
        expect(String(error)).not.toContain(privateMarker);
      }
    }
  }
  for (const type of [3, 6])
    expect(() => convertBangumi({ ...input(type), external_id: '82' })).toThrow(ConversionError);
});

test('identity/type dispatch is pure and never visits unknown or private subtrees', () => {
  const attempts: string[] = [];
  const deny = () => {
    attempts.push('I/O');
    throw new Error('Unexpected I/O');
  };
  const spies = [
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(deny, { preconnect: deny })),
    spyOn(fs, 'readFileSync').mockImplementation(deny),
    spyOn(fs, 'writeFileSync').mockImplementation(deny),
    spyOn(promises, 'readFile').mockImplementation(deny),
    spyOn(promises, 'writeFile').mockImplementation(deny),
    spyOn(http, 'request').mockImplementation(deny),
    spyOn(https, 'request').mockImplementation(deny),
    spyOn(net, 'connect').mockImplementation(deny),
    spyOn(childProcess, 'spawn').mockImplementation(deny),
  ];
  try {
    for (const type of [1, 2, 4, 3, 6]) {
      const request = input(type);
      Object.defineProperty(request.record, 'unknown', { enumerable: true, get: deny });
      Object.defineProperty(request.record, 'user', { enumerable: true, get: deny });
      const output = convertBangumi(request);
      const clean = input(type);
      delete (clean.record as Partial<ReturnType<typeof record>>).user;
      expect(output).toEqual(convertBangumi(clean));
      expect(output).not.toBeInstanceOf(Promise);
    }
    expect(attempts).toEqual([]);
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
});
