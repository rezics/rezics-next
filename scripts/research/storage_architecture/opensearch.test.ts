import { expect, test } from 'bun:test';
import { REALM, makeRoot, oracleEligible, toIndexed } from './opensearch-support';

test('fixture oracle distinguishes nested credit occurrence, local policy and rating', () => {
  const scale=10_000;
  const eligible=Array.from({length:scale},(_,i)=>makeRoot(i,scale)).filter(oracleEligible).map(root=>root.rootId);
  expect(eligible).toEqual(Array.from({length:5},(_,j)=>`resource:${String(scale-5+j).padStart(6,'0')}`));
  for(const i of [0,1,2,3,5])expect(oracleEligible(makeRoot(i,scale))).toBe(false);
  expect(oracleEligible(makeRoot(4,scale))).toBe(false);
  const cross=makeRoot(5,scale);
  expect(cross.credits.map(({agent,role})=>`${agent}/${role}`)).toEqual(['agent:A/author','agent:B/translator']);
  expect(oracleEligible(cross)).toBe(false);
  const omitted=toIndexed(makeRoot(scale-1,scale));
  expect(Object.hasOwn(omitted,'fixtureState')).toBe(false);
  expect(omitted.ratings[0]?.contextId).toBe(REALM.rating);
  expect(omitted.textUnits[1]?.positiveContexts).toEqual([REALM.publication]);
});

test('unavailable is a checkpoint error, while absent inherits and reject shadows', () => {
  const root=makeRoot(9999,10_000);
  root.fixtureState.publication='unavailable';
  expect(()=>oracleEligible(root)).toThrow('not ready');
  root.fixtureState.publication='reject';
  expect(oracleEligible(root)).toBe(false);
  root.fixtureState.publication='absent';
  expect(oracleEligible(root)).toBe(true);
  root.fixtureState.classification='unavailable';
  expect(()=>oracleEligible(root)).toThrow('not ready');
});
