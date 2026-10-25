import { expect, test } from 'bun:test';
import { RATE_LIMIT_V1, families, principalClasses, rateLimitBudgets } from '../../src/access/write-rate-budgets.ts';

test('versioned class family budgets preserve every applicable legacy numeric limit', () => {
  expect(principalClasses).toEqual(['anonymous', 'new-account', 'member', 'trusted', 'service']);
  expect(families).toEqual(['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address']);
  expect(RATE_LIMIT_V1).toEqual({
    anonymous: {
      write: { maximum: 10, seconds: 60 },
      upload: { maximum: 1, seconds: 86400 },
      report: { maximum: 10, seconds: 86400 },
      correspondence: { maximum: 20, seconds: 86400 },
      search: { maximum: 30, seconds: 60 },
      provider: { maximum: 1000, seconds: 60 },
      address: { maximum: 30, seconds: 60 },
    },
    'new-account': {
      write: { maximum: 30, seconds: 60 },
      upload: { maximum: 5, seconds: 86400 },
      report: { maximum: 20, seconds: 86400 },
      correspondence: { maximum: 40, seconds: 86400 },
      search: { maximum: 60, seconds: 60 },
      provider: { maximum: 1000, seconds: 60 },
      address: { maximum: 60, seconds: 60 },
    },
    member: {
      write: { maximum: 120, seconds: 60 },
      upload: { maximum: 30, seconds: 86400 },
      report: { maximum: 50, seconds: 86400 },
      correspondence: { maximum: 100, seconds: 86400 },
      search: { maximum: 120, seconds: 60 },
      provider: { maximum: 1000, seconds: 60 },
      address: { maximum: 120, seconds: 60 },
    },
    trusted: {
      write: { maximum: 600, seconds: 60 },
      upload: { maximum: 100, seconds: 86400 },
      report: { maximum: 100, seconds: 86400 },
      correspondence: { maximum: 300, seconds: 86400 },
      search: { maximum: 600, seconds: 60 },
      provider: { maximum: 1000, seconds: 60 },
      address: { maximum: 600, seconds: 60 },
    },
    service: {
      write: { maximum: 6000, seconds: 60 },
      upload: { maximum: 10000, seconds: 86400 },
      report: { maximum: 100, seconds: 86400 },
      correspondence: { maximum: 300, seconds: 86400 },
      search: { maximum: 6000, seconds: 60 },
      provider: { maximum: 1000, seconds: 60 },
      address: { maximum: 6000, seconds: 60 },
    },
  });

  const complete = rateLimitBudgets();
  expect(complete).toEqual(RATE_LIMIT_V1);
});

test('override parser rejects unknown and unbounded policy instead of disabling capacity', () => {
  const rejected = [
    'null',
    '[]',
    '{',
    '{"unknown":{"write":{"maximum":1,"seconds":60}}}',
    '{"anonymous":{"unknown":{"maximum":1,"seconds":60}}}',
    '{"anonymous":{"write":{"maximum":1,"seconds":60,"extra":true}}}',
    '{"anonymous":{"write":{"maximum":0,"seconds":60}}}',
    '{"anonymous":{"write":{"maximum":1000001,"seconds":60}}}',
    '{"anonymous":{"write":{"maximum":1.5,"seconds":60}}}',
    '{"anonymous":{"write":{"maximum":1e400,"seconds":60}}}',
    '{"anonymous":{"write":{"maximum":1,"seconds":1e400}}}',
    '{"anonymous":{"write":{"maximum":1,"seconds":0}}}',
    '{"anonymous":{"write":{"maximum":1,"seconds":86401}}}',
    '{"anonymous":{"write":{"maximum":1,"seconds":60.5}}}',
    '{"anonymous":{"write":{"maximum":1}}}',
    '{"anonymous":{"write":null}}',
    '{"anonymous":{"write":[]}}',
    '{"anonymous":[]}',
  ];

  for (const json of rejected) expect(() => rateLimitBudgets(json), json).toThrow();
});

test('parsed overrides do not mutate the frozen defaults', () => {
  expect(Object.isFrozen(RATE_LIMIT_V1)).toBe(true);
  expect(Object.isFrozen(RATE_LIMIT_V1.anonymous)).toBe(true);
  expect(Object.isFrozen(RATE_LIMIT_V1.anonymous.write)).toBe(true);

  const baseline = RATE_LIMIT_V1.anonymous.write;
  const first = rateLimitBudgets('{"anonymous":{"write":{"maximum":25,"seconds":120}}}');
  const second = rateLimitBudgets();

  expect(first.anonymous.write).toEqual({ maximum: 25, seconds: 120 });
  expect(first.member.upload).toEqual(RATE_LIMIT_V1.member.upload);
  expect(first).not.toBe(RATE_LIMIT_V1);
  expect(first.anonymous).not.toBe(RATE_LIMIT_V1.anonymous);
  expect(first.anonymous.write).not.toBe(RATE_LIMIT_V1.anonymous.write);
  expect(first.anonymous.upload).not.toBe(RATE_LIMIT_V1.anonymous.upload);
  expect(second.anonymous.write).toEqual(baseline);
  expect(RATE_LIMIT_V1.anonymous.write).toBe(baseline);

  first.anonymous.write.maximum = 75;
  expect(second.anonymous.write).toEqual(baseline);
  expect(RATE_LIMIT_V1.anonymous.write).toEqual(baseline);
});
