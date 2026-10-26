import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import { checkBatchWrite } from '../src/bulk.ts';
import {
  CoverCreditSchema,
  CoverProvenanceSchema,
  MediaImportAcceptedSchema,
  MediaImportRequestSchema,
  MediaImportStatusSchema,
  checkMediaImportRequest,
  checkMediaImportStatus,
  type MediaImportAccepted,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';

const id = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const request = (): MediaImportRequest => ({
  containerId: id,
  sourceUrl: 'https://images.example/cover.jpg',
  credit: {
    rightsHolder: 'Image creator',
    via: { name: 'Catalogue', url: 'https://catalogue.example/record/1' },
    license: 'LicenseRef-unknown',
    obligations: [],
  },
  provenance: {
    source: 'catalogue',
    external_id: '1',
    record_revision: 'unversioned',
    digest: 'a'.repeat(64),
    converter_revision: '1',
    field_group: 'cover',
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example/1' } }] },
    ],
  },
});
const status = (): MediaImportStatus => {
  const { containerId, credit, provenance } = request();
  return {
    media: {
      id,
      containerId,
      purpose: 'cover',
      state: 'reserved',
      byteCount: null,
      mediaType: null,
      sha256: null,
      credit,
      provenance,
    },
  };
};

test('portable request, accepted receipt and poll expose their bounded public shapes', () => {
  const input = request();
  expect(checkMediaImportRequest(input)).toEqual([]);
  expect(Compile(MediaImportRequestSchema).Check(input)).toBe(true);
  expect(Compile(CoverCreditSchema).Check(input.credit)).toBe(true);
  expect(Compile(CoverProvenanceSchema).Check(input.provenance)).toBe(true);
  const accepted: MediaImportAccepted = { media: { id, containerId: id, purpose: 'cover', state: 'reserved' } };
  expect(Compile(MediaImportAcceptedSchema).Check(accepted)).toBe(true);
  expect(Compile(MediaImportAcceptedSchema).Check({ ...accepted, status: 202 })).toBe(false);
  expect(checkMediaImportStatus(status())).toEqual([]);
  // Structural validity is independent of runtime host and publication authorization.
  input.sourceUrl = 'https://unconfigured.example/image';
  expect(checkMediaImportRequest(input)).toEqual([]);
});

test('authored crop and focal point use strict pixel and unit-fraction shapes', () => {
  const input = request() as MediaImportRequest & { crop?: string; focalPoint?: { x: number; y: number } };
  input.crop = 'xywh=10,20,300,400';
  input.focalPoint = { x: 0, y: 1 };
  expect(checkMediaImportRequest(input)).toEqual([]);
  expect(Compile(MediaImportRequestSchema).Check(input)).toBe(true);

  for (const crop of ['xywh=percent:10,20,30,40', 'xywh=-1,0,1,1', 'xywh=0,0,0,1', 'xywh=0,0,1.5,1', 'xywh=1,2,3']) {
    const malformed = { ...request(), crop };
    expect(checkMediaImportRequest(malformed).some((v) => v.pointer === '/crop')).toBe(true);
    expect(Compile(MediaImportRequestSchema).Check(malformed)).toBe(false);
  }
  expect(
    checkMediaImportRequest({ ...request(), crop: 'xywh=0,0,2147483648,1' }).some((v) => v.pointer === '/crop'),
  ).toBe(true);
  for (const focalPoint of [{ x: -0.01, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: 0.5 }, { x: 0.5, y: 0.5, z: 0 }]) {
    const malformed = { ...request(), focalPoint };
    expect(checkMediaImportRequest(malformed).some((v) => v.pointer.startsWith('/focalPoint'))).toBe(true);
    expect(Compile(MediaImportRequestSchema).Check(malformed)).toBe(false);
  }
});

test('closed envelopes retain bulk citation parts and refuse private or unknown members', () => {
  const input = request();
  input.provenance.references[0]!.parts.push(
    { property: { id: 'schema:name' }, value: { type: 'value', content: { language: 'en', text: 'Title' } } },
    { property: { id: 'schema:datePublished' }, value: { type: 'somevalue' } },
    { property: { id: 'schema:author' }, value: { type: 'novalue' } },
  );
  expect(checkMediaImportRequest(JSON.parse(JSON.stringify(input)))).toEqual([]);
  for (const [target, member] of [
    [input, 'storageKey'],
    [input.credit, 'attribution'],
    [input.credit.via, 'token'],
    [input.provenance, 'url'],
    [input.provenance.references[0]!, 'url'],
    [input.provenance.references[0]!.parts[0]!, 'extra'],
    [input.provenance.references[0]!.parts[0]!.property, 'extra'],
    [input.provenance.references[0]!.parts[0]!.value, 'extra'],
  ] as const) {
    Object.assign(target, { [member]: true });
    expect(checkMediaImportRequest(input).some((v) => v.code === 'unknown_field')).toBe(true);
    expect(Compile(MediaImportRequestSchema).Check(input)).toBe(false);
    Reflect.deleteProperty(target, member);
  }
  for (const member of ['sourceUrl', 'originalObjectKey', 'token']) {
    const poll = status();
    Object.assign(poll.media, { [member]: 'private' });
    expect(checkMediaImportStatus(poll)).toContainEqual({ pointer: `/media/${member}`, code: 'unknown_field' });
  }
});

test('URL, credit and provenance bounds are enforced with bulk violation pointers', () => {
  const cases: [string, (input: MediaImportRequest) => void][] = [
    [
      '/containerId',
      (x) => {
        x.containerId = 'subject';
      },
    ],
    [
      '/sourceUrl',
      (x) => {
        x.sourceUrl = 'http://images.example/cover';
      },
    ],
    [
      '/sourceUrl',
      (x) => {
        x.sourceUrl = 'https://[invalid';
      },
    ],
    [
      '/sourceUrl',
      (x) => {
        x.sourceUrl = 'https://example/' + 'a'.repeat(2048);
      },
    ],
    [
      '/credit/via/url',
      (x) => {
        x.credit.via.url = 'relative';
      },
    ],
    [
      '/credit/rightsHolder',
      (x) => {
        x.credit.rightsHolder = 'a'.repeat(1025);
      },
    ],
    [
      '/credit/via/name',
      (x) => {
        x.credit.via.name = '';
      },
    ],
    [
      '/credit/via/url',
      (x) => {
        x.credit.via.url = 'https://example/' + 'a'.repeat(1024);
      },
    ],
    [
      '/provenance/field_group',
      (x) => {
        Object.assign(x.provenance, { field_group: 'summary' });
      },
    ],
    [
      '/provenance/digest',
      (x) => {
        x.provenance.digest = 'sha256:abc';
      },
    ],
    [
      '/provenance/references',
      (x) => {
        x.provenance.references = [];
      },
    ],
    [
      '/provenance/references',
      (x) => {
        x.provenance.references = Array(129).fill(x.provenance.references[0]);
      },
    ],
    [
      '/provenance/references/0/parts',
      (x) => {
        x.provenance.references[0]!.parts = [];
      },
    ],
  ];
  for (const [pointer, mutate] of cases) {
    const input = request();
    mutate(input);
    expect(checkMediaImportRequest(input).some((v) => v.pointer === pointer)).toBe(true);
  }
  const input = request();
  input.sourceUrl = 'https://example/' + 'a'.repeat(2048 - 'https://example/'.length);
  input.credit.rightsHolder = 'a'.repeat(1024);
  input.provenance.references = Array(128).fill(input.provenance.references[0]);
  expect(checkMediaImportRequest(input)).toEqual([]);
  for (const invalid of [null, [], {}, 42]) expect(checkMediaImportRequest(invalid).length).toBeGreaterThan(0);
});

test('image rights reuse the exact bulk SPDX, LicenseRef and distinct obligation checks', () => {
  for (const license of [
    'CC-BY-SA-3.0',
    'LicenseRef-unknown',
    'LicenseRef-image.1',
    'MadeUp',
    'LicenseRef-',
    'MIT\n',
  ]) {
    for (const obligations of [
      [],
      ['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'],
      ['cc:Pay'],
      ['cc:Notice', 'cc:Notice'],
      Array(5).fill('cc:Notice'),
    ]) {
      const input = request();
      Object.assign(input.credit, { license, obligations });
      const errors = checkBatchWrite({
        commands: [
          {
            op: 'propose',
            source: { field_group: 'summary' },
            rights: { license, obligations, attribution: 'credit' },
          },
        ],
      });
      const expected = errors
        .filter((v) => v.pointer.startsWith('/commands/0/rights/'))
        .map((v) => ({ ...v, pointer: v.pointer.replace('/commands/0/rights', '/credit') }));
      expect([...checkMediaImportRequest(input)] as { pointer: string; code: string }[]).toEqual(expected);
      const poll = status();
      poll.media.credit = input.credit;
      expect([...checkMediaImportStatus(poll)] as { pointer: string; code: string }[]).toEqual(
        expected.map((v) => ({ ...v, pointer: '/media' + v.pointer })),
      );
    }
  }
});

test('poll states require measured positive bytes, type and digest after upload', () => {
  for (const state of ['uploaded', 'available'] as const) {
    const poll = status();
    Object.assign(poll.media, { state });
    expect(checkMediaImportStatus(poll).length).toBeGreaterThan(0);
    expect(Compile(MediaImportStatusSchema).Check(poll)).toBe(false);
    Object.assign(poll.media, { byteCount: 123, mediaType: 'image/jpeg', sha256: 'b'.repeat(64) });
    expect(checkMediaImportStatus(poll)).toEqual([]);
    expect(Compile(MediaImportStatusSchema).Check(poll)).toBe(true);
    for (const byteCount of [0, -1, 0.5, NaN, Infinity]) {
      Object.assign(poll.media, { byteCount });
      expect(checkMediaImportStatus(poll).length).toBeGreaterThan(0);
    }
  }
  const rejected = status();
  rejected.media.state = 'rejected';
  rejected.media.rejection = { code: 'source_unavailable' };
  expect(checkMediaImportStatus(rejected)).toEqual([]);
  Object.assign(rejected.media.rejection, { sourceUrl: 'https://private/' });
  expect(checkMediaImportStatus(rejected)).toContainEqual({
    pointer: '/media/rejection/sourceUrl',
    code: 'unknown_field',
  });
});
