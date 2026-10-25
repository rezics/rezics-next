import {expect,test} from 'bun:test';
import {checkBatchWrite} from '@rezics/definitions/bulk';
import bangumi from '../../../specs/fixtures/imports/bangumi/subject.json';
import vndb from '../../../specs/fixtures/imports/vndb/record.json';
import wikidata from '../../../specs/fixtures/imports/wikidata/entity.json';
import {convertBangumi} from '../src/bangumi';
import {convertVndb} from '../src/vndb';
import {convertWikidata} from '../src/wikidata';

const samples=[
 {convert:convertBangumi,input:{external_id:String(bangumi.id),record_revision:'7',record:bangumi}},
 {convert:convertVndb,input:{external_id:vndb.vn.id,record_revision:String(vndb.entry_meta.revision),record:vndb}},
 {convert:convertWikidata,input:{external_id:wikidata.id,record_revision:String(wikidata.lastrevid),record:wikidata}},
];
test('configured feeds have isolated envelopes and command identities without changing source digest',()=>{
 for(const sample of samples){
  for(const target of [{},{subjectId:'00000000-0000-4000-8000-000000000001'}]){
   const a=sample.convert(sample.input,{...target,source:'feed-one'});
   const b=sample.convert(sample.input,{...target,source:'feed-two'});
   expect(a.proposals.length).toBeGreaterThan(0);
   expect(checkBatchWrite({commands:a.proposals})).toEqual([]);
   expect(checkBatchWrite({commands:b.proposals})).toEqual([]);
   expect(a.proposals.every(c=>c.source.source==='feed-one')).toBe(true);
   expect(b.proposals.every(c=>c.source.source==='feed-two')).toBe(true);
   expect(b.proposals.every(c=>!new Set(a.proposals.map(c=>c.key)).has(c.key))).toBe(true);
   expect(a.digest).toBe(b.digest);
   expect(sample.convert(sample.input,{...target,source:'feed-one'})).toEqual(a);
  }
  for(const source of ['Bad Alias','x'.repeat(33),'']) expect(()=>sample.convert(sample.input,{source})).toThrow();
 }
 const cover=convertBangumi(samples[0]!.input,{source:'feed-one',subjectId:'00000000-0000-4000-8000-000000000001'});
 expect(cover.mediaImportIntents.length).toBeGreaterThan(0);
 expect(cover.mediaImportIntents.every(a=>a.provenance.source==='feed-one')).toBe(true);
});
