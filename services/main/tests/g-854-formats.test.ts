import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseLibraryFile, adapters } from '../src/modules/library-import/formats/index.ts';
import { inspectGenericCsv } from '../src/modules/library-import/formats/generic-csv.ts';
import { FileImportInvalid, emptyRow } from '../src/modules/library-import/formats/contract.ts';
import { globalImportRating } from '../src/modules/library-import/apply.ts';
import { chooseCandidates } from '../src/modules/library-import/match.ts';
import { importDigest } from '../src/modules/library-import/file-store.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/library-exports/${name}`,import.meta.url),'utf8');
test('G-854: generic mapping retains every unmapped field, status value and chapter label', () => {
  const file = fixture('novelupdates.csv');
  const preview = inspectGenericCsv(file);
  expect(preview.distinctValues.Status).toEqual(['Reading','Dropped']);
  const rows = parseLibraryFile('generic-csv',file,{ title: 'Title',author: 'Author',status: 'Status',progress: 'Progress',
    startedOn: 'Started',finishedOn: 'Finished',statuses: { Reading: 'reading',Dropped: 'dnf' } });
  expect(rows.map(r => [r.title,r.status,r.startedOn,r.finishedOn,r.progress])).toEqual([
    ['Shared Moon','reading','2026-09-01',null,null],['Dropped Moon','dnf','2026-08','2026-09',null] ]);
  expect(rows[0]!.raw).toEqual({ Title: 'Shared Moon',Author: 'Reader Writer',Status: 'Reading',Progress: 'c123',
    Started: '2026-09-01',Finished: '',Translator: 'Private fan group' });
  expect(parseLibraryFile('generic-csv',file,{ title: 'Title',status: 'Status',statuses: {} })[1]!.status).toBeNull();
  expect(parseLibraryFile('generic-csv','Title,Status\nPrivate book,constructor',
    { title: 'Title',status: 'Status',statuses: {} })[0]!.status).toBeNull();
  expect(parseLibraryFile('generic-csv','Title,Progress\nPage book,12\nPercent book,42%',
    { title: 'Title',progress: 'Progress',progressUnit: 'page',statuses: {} }).map(r => r.progress))
    .toEqual([{ unit: 'page',value: 12 },{ unit: 'percentage',value: 42 }]);
});
test('G-854: Goodreads golden preserves editions, read count, DNF dates, reviews and all source columns', () => {
  const rows = parseLibraryFile('goodreads',fixture('goodreads.csv'));
  expect(rows.map(r => [r.sourceId,r.status,r.startedOn,r.finishedOn,r.readCount])).toEqual([
    ['101','read','2026-01-01','2026-02-01',2],['102','dnf','2026-08-01','2026-09-01',0],['103','want-to-read',null,null,0] ]);
  expect(rows[0]!.identifiers).toEqual([{ provider: 'isbn13',value: '9780306406157' }]);
  expect(rows[2]!.identifiers).toEqual([{ provider: 'isbn13',value: '9780140328721' }]);
  expect(globalImportRating(rows[0]!)).toBe(4);
  expect(rows[0]!.review).toEqual({ text: 'Remember this',language: 'und',spoiler: false });
  expect(rows[0]!.raw['Private Notes']).toBe('Original note');
});
test('G-854: StoryGraph quarter stars remain on their source scale with review and custom fields', () => {
  const [row] = parseLibraryFile('storygraph',fixture('storygraph.csv'));
  expect(row).toMatchObject({ status: 'read',score: { value: 3.5,min: 0.25,max: 5,step: 0.25 },raw: { Moods: 'hopeful' } });
  expect(globalImportRating(row!)).toBeNull();
  expect(parseLibraryFile('storygraph','Title,Read Status\nPrivate book,constructor')[0]!.status).toBeNull();
});
test('G-854: REZICS golden round trip preserves explicit nulls, arbitrary private fields and session locators', () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const row = { ...emptyRow('source-1','', { nested: { original: ['c123',null] } }),kind: 'session' as const,work,
    session: { target: work,state: 'paused' as const,startedOn: '2026-09',finishedOn: null,
      selections: [{ target: work }],locators: [] } };
  expect(parseLibraryFile('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [row] }))).toEqual([row]);
});
test('G-854: VNDB native XML golden retains all attributes, notes, releases, length votes and reviews', () => {
  const rows = parseLibraryFile('vndb',fixture('vndb.xml'));
  expect(rows[0]).toMatchObject({ status: 'paused',startedOn: '2026-09-01',score: { value: 8.5,min: 1,max: 10,step: 0.1 },
    identifiers: [{ provider: 'https://vndb.org/vn',value: 'v17' }] });
  expect(rows[1]).toMatchObject({ status: 'dnf',startedOn: '2026-08',finishedOn: '2026-09' });
  expect(rows.find(r => r.sourceId === 'reviews:w1')?.review).toEqual({ text: 'Private imported review',language: 'und',spoiler: true });
  expect(rows.find(r => r.sourceId.startsWith('length-votes'))?.raw.xml).toMatchObject({ children: expect.arrayContaining([
    expect.objectContaining({ name: 'minutes',text: '1200' }) ]) });
  expect(rows[0]!.raw.xml).toMatchObject({ children: expect.arrayContaining([expect.objectContaining({ name: 'notes',text: 'Private note & evidence' })]) });
  expect(globalImportRating(rows[0]!)).toBeNull();
  const mixed = parseLibraryFile('vndb','<vndb-export version="1.0"><vns custom="kept"><vn id="v17"><title>Before<b>inside</b>after</title></vn><future>extra</future></vns></vndb-export>');
  expect(mixed[0]!.raw.xml).toMatchObject({ children: expect.arrayContaining([expect.objectContaining({ name: 'title',
    content: [{ type: 3,value: 'Before' },{ child: 0 },{ type: 3,value: 'after' }] })]) });
  expect(mixed.find(r => r.sourceId === 'vns-extra:0')?.raw.xml).toMatchObject({ text: 'extra' });
  expect(mixed.at(-1)?.raw.vnsAttributes).toEqual({ custom: 'kept' });
  expect(parseLibraryFile('vndb','<vndb-export version="1.0"><vns><vn id="v17"><title>Private VN</title><label label="constructor"/></vn></vns></vndb-export>')[0]!.status).toBeNull();
  for (const bad of ['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><vndb-export/>','<vndb-export version="1.0"><vn></vndb-export>']) {
    expect(() => parseLibraryFile('vndb',bad)).toThrow(FileImportInvalid);
  }
});
test('G-854: MAL anime and manga golden preserve partial dates, scores, notes and repeat/episode/chapter evidence', () => {
  const manga = parseLibraryFile('mal',fixture('mal-manga.xml')).filter(r => r.kind === 'source');
  expect(manga.map(r => [r.sourceId,r.status,r.startedOn,r.finishedOn,r.readCount,r.progress])).toEqual([
    ['manga:101','paused','2026-08',null,4,null],['manga:102','dnf','2026','2026-09',null,null],
    ['manga:103','dnf','2026-07','2026-08',null,null] ]);
  expect(manga[0]).toMatchObject({ score: { value: 8,min: 1,max: 10,step: 1 },
    identifiers: [{ provider: 'https://myanimelist.net/manga',value: '101' }],
    review: { text: 'Remember the chapter & translator',language: 'und',spoiler: false },
    shelves: ['Light novels','Private favourites'],raw: { xml: { attributes: { custom: 'kept' },children: expect.arrayContaining([
      expect.objectContaining({ name: 'my_read_chapters',text: '123' }),
      expect.objectContaining({ name: 'my_scanalation_group',text: 'Private group' }),
      expect.objectContaining({ name: 'future',content: [{ type: 3,value: 'before' },{ child: 0 },{ type: 3,value: 'after' }] }) ]) } } });
  expect(globalImportRating(manga[0]!)).toBeNull();
  expect(manga[1]!.score).toBeNull();
  const anime = parseLibraryFile('mal',fixture('mal-anime.xml'));
  expect(anime.filter(r => r.kind === 'source').map(r => [r.sourceId,r.status,r.startedOn,r.finishedOn,r.readCount,r.progress]))
    .toEqual([['anime:201','reading','2026-09-01',null,3,null],['anime:202','want-to-read',null,null,null,null]]);
  expect(anime[1]!.raw.xml).toMatchObject({ children: expect.arrayContaining([
    expect.objectContaining({ name: 'my_watched_episodes',text: '12' }),expect.objectContaining({ name: 'my_rewatching_ep',text: '5' }) ]) });
  expect(anime.filter(r => r.kind === 'retained')).toHaveLength(2);
  for (const format of ['mal','vndb'] as const) {
    const root = format === 'mal' ? 'myanimelist' : 'vndb-export';
    for (const xml of [`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><${root}/>`,
      `<${root}><x></${root}>`,`<${root}>${'<x>'.repeat(66)}${'</x>'.repeat(66)}</${root}>`]) {
      expect(() => parseLibraryFile(format,xml)).toThrow(FileImportInvalid);
    }
  }
});
test('G-854: adapter bounds reject truncation, invalid CSV and malformed bundles', () => {
  for (const file of ['Title,Title\nx,y','Title\n"unclosed','Title\n"ok"x','Title\nx,y',`Title\n${'x'.repeat(20_001)}`,
    `Title\n${Array.from({ length: 5001 },() => 'x').join('\n')}`]) {
    expect(() => parseLibraryFile('generic-csv',file,{ title: 'Title',statuses: {} })).toThrow(FileImportInvalid);
  }
  expect(() => parseLibraryFile('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [{}] }))).toThrow();
  expect(() => parseLibraryFile('goodreads','x'.repeat(2*1024*1024+1))).toThrow();
  const large = { ...emptyRow('large','', { evidence: 'x'.repeat(1024*1024) }) };
  expect(() => parseLibraryFile('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [large] }))).toThrow();
  expect(parseLibraryFile('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [{ ...large,kind: 'retained' }] }))).toHaveLength(1);
  expect(Object.keys(adapters)).not.toContain('anilist');
  expect(() => parseLibraryFile('mal','<myanimelist/>')).toThrow(FileImportInvalid);
});
test('G-854: ambiguous and incomplete catalogue windows never become automatic matches', () => {
  const row = { ...emptyRow('1','Shared Moon',{}),creators: ['Reader Writer'] };
  const candidate = { work: 'work1',target: null,title: 'Shared Moon',creators: ['Reader Writer'] };
  expect(chooseCandidates(row,[candidate]).kind).toBe('matched');
  expect(chooseCandidates(row,[candidate,{ ...candidate,work: 'work2' }]).kind).toBe('ambiguous');
  expect(chooseCandidates(row,[candidate],true).kind).toBe('ambiguous');
  expect(importDigest({ a: 1,b: { z: 2,c: 3 } })).toBe(importDigest({ b: { c: 3,z: 2 },a: 1 }));
});
