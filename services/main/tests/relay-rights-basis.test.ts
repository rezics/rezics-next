import { describe, expect, test } from 'bun:test';
import { eligibleRightsBasis } from '../src/modules/outbox/relay.ts';
import { RV } from '../src/modules/work/activate.ts';

describe('relayed Content search eligibility', () => {
  test('accepts original contributions and assessed public-domain texts, nothing else', () => {
    expect(eligibleRightsBasis(`${RV}OriginalContribution`)).toBe(true);
    // G-389's content-search-eligibility-v2 records public-domain texts; the relay blocked on them.
    expect(eligibleRightsBasis(`${RV}PublicDomain`)).toBe(true);
    expect(eligibleRightsBasis(`${RV}Licensed`)).toBe(false);
    expect(eligibleRightsBasis(undefined)).toBe(false);
  });
});
