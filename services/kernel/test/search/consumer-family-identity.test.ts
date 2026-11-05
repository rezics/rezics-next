import { expect, test } from 'bun:test';
import { discoveryConsumer, subjectConsumer } from '../../src/search/consumer-name.ts';

const native = (name: string) => name.length <= 63 && /^[a-z][a-z0-9_]{0,62}/.exec(name)?.[0] === name;
const near = 'a'.repeat(45);
const admitted = 'a'.repeat(48);

test('search consumer families stay exact, distinct and native-bounded', () => {
  expect(subjectConsumer('rezics-', 1)).toBe('search_rezics_subjects_g1');
  expect(discoveryConsumer('rezics-', 1)).toBe('search_rezics_discovery_g1');
  expect(subjectConsumer('rezics-', Number.MAX_SAFE_INTEGER)).toBe('search_rezics_subjects_g9007199254740991');

  expect(discoveryConsumer('subjects-', 1)).toBe('search_subjects_discovery_g1');
  expect(subjectConsumer('discovery-', 1)).toBe('search_discovery_subjects_g1');
  expect(discoveryConsumer('foo-subjects-', 1)).toBe('search_foo_subjects_discovery_g1');
  expect(subjectConsumer('foo-discovery-', 1)).toBe('search_foo_discovery_subjects_g1');

  expect(subjectConsumer(near, 1)).toBe(`search_${near}subjects_g1`);
  expect(subjectConsumer(near, 1).length).toBe(63);
  expect(discoveryConsumer(near, 1)).toBe('search_hc15d1cf98d59411b611e471bd039cd81d_g1');

  const longSubject = subjectConsumer(admitted, Number.MAX_SAFE_INTEGER);
  const longDiscovery = discoveryConsumer(admitted, Number.MAX_SAFE_INTEGER);
  expect(longSubject).toBe('search_h2d274556d1f056b8540af32fd12554d7s_g9007199254740991');
  expect(longDiscovery).toBe('search_h0c7376413f3695562fea1e48509d02cfd_g9007199254740991');
  expect(longSubject).not.toBe(longDiscovery);
  expect([longSubject, longDiscovery, discoveryConsumer(near, 1), subjectConsumer(admitted, 1)].every(native)).toBe(
    true,
  );

  for (const invalid of [
    ['rezics-\n', 1],
    ['rezics-\r', 1],
    ['rezics-', 0],
    ['rezics-', 1.5],
    ['rezics-', Number.MAX_SAFE_INTEGER + 1],
    ['', 1],
  ] as const)
    expect(() => subjectConsumer(invalid[0], invalid[1])).toThrow(RangeError);
});
