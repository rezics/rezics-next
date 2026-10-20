import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { convertProviderRecord, convertBangumiSubject, ProviderConversionError } from '../../../packages/conversion/src/index.ts';

const identity = { key: 'vndb:vn:v11',provider: 'vndb',namespace: 'vn',externalId: 'v11' };
test('external provider conversion preserves exact supplied primitives and rejects unsupported enrichment', () => {
  const data = { id: 'v11',name: '',olang: '',description: '  One\r\nTwo\t',description_language: null,
    released: '20049999',aliases: ['A','','A'],decimal: '1.500',empty: [],flag: false };
  const before = structuredClone(data), converted = convertProviderRecord(identity,data);
  expect(converted).toEqual({ key: identity.key,provider: 'vndb',kind: 'vn',externalId: 'v11',
    title: '',language: '',sourceUrl: 'https://vndb.org/v11',native: 'work',
    semanticTypes: ['https://schema.org/VideoGame'],data });
  expect(data).toEqual(before); expect(Object.hasOwn(converted.data,'omitted')).toBe(false);
  expect(() => convertProviderRecord(identity,{ ...data,id: 'v12' })).toThrow(ProviderConversionError);
  expect(() => convertProviderRecord({ ...identity,provider: 'bangumi' },data)).toThrow(ProviderConversionError);
  const artist = convertProviderRecord({ key: 'musicbrainz:artist:original',provider: 'musicbrainz',
    namespace: 'artist',externalId: 'original' },{ id: 'original',name: 'Exact',type: 'Person',
    'text-representation': { language: 'EN-us' },'life-span': { begin: '1685-03' } });
  expect(artist.language).toBe('EN-us'); expect(artist.native).toBe('person');
  expect(artist.data['life-span']).toEqual({ begin: '1685-03' });
});

test('the exported conversion package runs when copied away from Main and importer code', async () => {
  await mkdir('.temp',{ recursive: true });
  const directory = await mkdtemp(resolve('.temp/conversion-library-'));
  try {
    await mkdir(join(directory,'src'));
    await copyFile('packages/conversion/package.json',join(directory,'package.json'));
    for (const name of ['index.ts','bangumi.ts','errors.ts'])
      await copyFile(`packages/conversion/src/${name}`,join(directory,'src',name));
    await writeFile(join(directory,'run.ts'),`
      import { convertProviderRecord } from './src/index.ts';
      const record = convertProviderRecord(${JSON.stringify(identity)}, { id: 'v11',name: 'Exact',olang: 'ja' });
      if (record.title !== 'Exact' || record.externalId !== 'v11') throw new Error('conversion differs');
      process.stdout.write(JSON.stringify(record));
    `);
    const run = Bun.spawn([process.execPath,'run.ts'],{ cwd: directory,stdout: 'pipe',stderr: 'pipe' });
    const [out,err,code] = await Promise.all([new Response(run.stdout).text(),new Response(run.stderr).text(),run.exited]);
    expect({ code,err }).toEqual({ code: 0,err: '' });
    expect(JSON.parse(out)).toMatchObject({ key: identity.key,native: 'work',title: 'Exact' });
  } finally { await rm(directory,{ recursive: true,force: true }); }
});

test('Bangumi explicit conversion shares the external pure transformation and preserves repeated source values', () => {
  const converted = convertBangumiSubject('1014',{ id: 1014,name: 'Exact',type: 2,
    summary: 'One\r\nTwo',tags: [{ name: 'A' },{ name: 'A' }],unknown: null });
  expect(converted.values.fields[0]!.value).toBe('One\r\nTwo');
  expect(converted.values.children[0]!.values!.map(item => item.pointer)).toEqual(['/tags/0/name','/tags/1/name']);
  expect(converted.inventory.find(item => item.field === 'unknown')).toMatchObject({ disposition: 'unsupported' });
  expect(() => convertBangumiSubject('other',{ id: 1014,name: 'Exact',type: 2 })).toThrow(ProviderConversionError);
});


test('VNDB namespaces accept only declared kinds and refuse inherited object members', () => {
  const data = { id: 'v11',name: 'Exact',olang: 'ja' };
  for (const [namespace,native] of [['vn','work'],['release','release'],['character','character'],
    ['staff','person'],['producer','organization'],['tag','concept'],['trait','concept']] as const) {
    expect(convertProviderRecord({ ...identity,namespace },data).native).toBe(native);
  }
  for (const namespace of [...Object.getOwnPropertyNames(Object.prototype),'not-a-kind','']) {
    let refusal: unknown;
    try { convertProviderRecord({ ...identity,namespace },data); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(ProviderConversionError);
    if (refusal instanceof ProviderConversionError) expect(refusal.basis).toBe('unsupported');
  }
});
