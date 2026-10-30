import { afterAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import { authoritativeTimeValue, mintReadTime } from '../../src/command/command.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { itemFacts, SubjectInputError } from '../../src/semantic/item.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(() => pool.end());

test('minting a configured clock retains its original ISO value with one clock call', async () => {
  const fixed = new Date('2025-01-02T03:04:05.067Z');
  let calls = 0;
  const time = await withConnection(pool, (client) =>
    mintReadTime(client, () => {
      calls++;
      return fixed;
    }),
  );
  expect(calls).toBe(1);
  expect(authoritativeTimeValue(time)).toBe(fixed.toISOString());
});

test('typed statement fragments build relation facts while complete subjects still require labels', () => {
  const subject = newId(0);
  const target = newId(1);
  const fragment = {
    statements: {
      'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: target } }],
    },
  };
  const facts = itemFacts(subject, fragment, 'schema:Book', bundledRelease);
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({
    kind: 'statement',
    property: 'schema:author',
    body: { value: { type: 'value', content: target } },
  });
  expect(checkSubjectStructure(fragment, bundledRelease).violations).toEqual([
    { pointer: '/labels', code: 'required' },
  ]);
  expect(() => itemFacts(subject, fragment)).toThrow(SubjectInputError);
  expect(() => itemFacts(subject, { ...fragment, labels: {} }, 'schema:Book', bundledRelease)).toThrow(
    SubjectInputError,
  );
  expect(() =>
    itemFacts(
      subject,
      { statements: { 'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value' } }] } },
      'schema:Book',
      bundledRelease,
    ),
  ).toThrow(SubjectInputError);
});
