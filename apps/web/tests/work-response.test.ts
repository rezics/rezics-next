import { expect, test } from 'bun:test';
import { canonicalFlight } from './work-response.ts';

test('Flight allocation, emission order and outlined paths normalize without changing shared/cyclic data', () => {
  const first = '0:{"value":"$La","path":"$a:label","escaped":"$$a","symbol":"$Sreact.fragment","empty":"$undefined"}\n'
    + 'a:{"label":"public","back":"$0","component":"$b"}\nb:I["module",[],"$c",1]\nc:"Export"\n'
    + ':HL["font","font"]\n:HL["style","style"]\n';
  const reordered = ':HL["style","style"]\n7:"Export"\n'
    + '2:{"component":"$4","back":"$0","label":"public"}\n4:I["module",[],"$7",1]\n'
    + '0:{"empty":"$undefined","symbol":"$Sreact.fragment","escaped":"$$a","path":"$2:label","value":"$L2"}\n'
    + ':HL["font","font"]\n';
  expect(canonicalFlight(reordered)).toBe(canonicalFlight(first));
  expect(canonicalFlight(first.replace('"public"', '"private-work"'))).not.toBe(canonicalFlight(first));
  expect(canonicalFlight(first.replace('$La', '$a'))).not.toBe(canonicalFlight(first));
});

test('Flight literal text uses UTF-8 byte framing and keeps dollar text and newlines', () => {
  const literal = '$0\n水';
  const length = new TextEncoder().encode(literal).length.toString(16);
  const actual = canonicalFlight(`0:{"text":"$1"}\n1:T${length},${literal}`);
  expect(JSON.parse(actual).models[1]).toEqual({ tag: 'T', value: literal });
});

test('Flight comparison refuses dropped, missing, duplicate or unsupported serialized data', () => {
  expect(() => canonicalFlight('0:"public"\n1:"private-work"\n')).toThrow('outside the root graph');
  expect(() => canonicalFlight('0:"$1"\n')).toThrow('Missing Flight reference');
  expect(() => canonicalFlight('0:null\n0:null\n')).toThrow('duplicate');
  expect(() => canonicalFlight('0:A0,')).toThrow('Unsupported Flight record tag');
});
