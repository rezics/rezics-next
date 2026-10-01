import { expect,test } from 'bun:test';
import { retainedFields } from './g-855-library.ts';

test('G856: retained records compare content across JSON key ordering without hiding data changes',() => {
  const before = [{ kind: 'retained',raw: { source: { title: 'Private title',score: 8.5 },steps: [1,2] } }];
  const reordered = [{ kind: 'retained',raw: { steps: [1,2],source: { score: 8.5,title: 'Private title' } } }];
  expect(retainedFields(reordered)).toEqual(retainedFields(before));
  expect(retainedFields([{ kind: 'retained',raw: { ...before[0]!.raw,steps: [2,1] } }])).not.toEqual(retainedFields(before));
  expect(retainedFields([{ kind: 'retained',raw: { ...before[0]!.raw,source: { title: 'Private title' } } }])).not.toEqual(retainedFields(before));
});
