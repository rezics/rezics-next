import { expect, test } from 'bun:test';
import {
  admitFilter,
  FILTER_LIMITS,
  FilterError,
  parseFilter,
  validateFilter,
  walkFilter,
  type FieldErrorCode,
  type FilterDocument,
  type FilterProblem,
  type FilterRelease,
  type OwnerLeaf,
} from '../src/index.ts';

const label = '018f0000-0000-7000-8000-00b00000000a';
const book = { type: { in: ['schema:Book'] } };
const qualified = {
  statement: {
    property: 'schema:genre',
    in: [label],
    qualifiers: [{ property: 'rezics:role', in: [label] }],
  },
};
const families: OwnerLeaf[] = [
  { owner: { presence: true } },
  { owner: { state: { profileId: 'book.reading', stateSetId: 'legacy-five', in: ['planned', 'in_progress'] } } },
  { owner: { label: { id: label } } },
  ...(['active', 'completed', 'abandoned'] as const).map((lifecycle) => ({
    owner: { session: { profileId: 'recipe.v2', lifecycle } },
  })),
  { owner: { holding: { profileId: 'legacy-fixed-v1' } } },
  { owner: { holding: { profileId: 'book.reading', kind: 'physical' } } },
  { owner: { holding: { profileId: 'book.reading', status: 'owned' } } },
  { owner: { holding: { profileId: 'book.reading', kind: 'physical', status: 'owned' } } },
];
const release: FilterRelease = {
  types: { 'schema:Book': { facets: ['schema:genre'] } },
  properties: {
    'schema:genre': { datatype: 'wikibase-item', qualifiers: ['rezics:role'] },
    'rezics:role': { datatype: 'wikibase-item' },
  },
  filters: Object.fromEntries(families.map((filter, i) => [`owner/family-${i}`, { filter }])),
};
const ownerContext = { owner: true } as const;
const admit = (input: unknown, snapshot = release) => admitFilter(parseFilter(input), snapshot, ownerContext);

function refuses(
  action: () => unknown,
  pointer: string,
  code: FieldErrorCode,
  problem: FilterProblem = 'invalid_request',
) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FilterError);
  expect((caught as FilterError).problem).toBe(problem);
  expect((caught as FilterError).errors).toEqual([{ pointer, code }]);
}

test('owner presence state label session holding are closed leaves of the same bounded Boolean Filter AST', () => {
  for (const leaf of families) {
    for (const input of [leaf, { and: [book, leaf] }, { or: [book, leaf] }, { not: leaf }]) {
      expect(parseFilter(input)).toEqual(input);
      expect(admit(input)).toEqual(input);
      expect(validateFilter(input, release, ownerContext)).toEqual([]);
    }
    const parsed = parseFilter(leaf);
    expect(parsed).not.toBe(leaf);
    if (!('owner' in parsed)) throw new Error('Expected shared owner leaf');
    expect(parsed.owner).not.toBe(leaf.owner);
  }
  // No active release/type lookup can establish the meaning of a stored historic pin.
  expect(admit(families[1], { types: {}, properties: {} })).toEqual(families[1]);
});

test('catalogue only admission rejects all owner families including owner under NOT and saved expansion', () => {
  families.forEach((leaf, i) => {
    refuses(() => admitFilter(parseFilter(leaf), release), '/owner', 'unsupported', 'unsupported_query');
    refuses(
      () => admitFilter(parseFilter({ and: [book, { not: leaf }] }), release),
      '/and/1/not/owner',
      'unsupported',
      'unsupported_query',
    );
    refuses(
      () => admitFilter(parseFilter({ saved: `owner/family-${i}` }), release),
      '/saved',
      'unsupported',
      'unsupported_query',
    );
    expect(validateFilter({ not: leaf }, release)).toEqual([
      { problem: 'unsupported_query', pointer: '/not/owner', code: 'unsupported' },
    ]);
  });
});

test('owner saved expansion uses the same parser, Boolean limits and admission context', () => {
  families.forEach((leaf, i) => {
    expect(admit({ saved: `owner/family-${i}` })).toEqual(leaf);
    expect(admit({ not: { saved: `owner/family-${i}` } })).toEqual({ not: leaf });
  });
  refuses(
    () => admitFilter(parseFilter({ saved: 'owner/family-0' }), release, { owner: true, saved: false }),
    '/saved',
    'unsupported',
    'unsupported_query',
  );
  for (const filter of [{ owner: { presence: false } }, { saved: 'owner/family-0' }]) {
    refuses(
      () => admit({ not: { saved: 'owner/broken' } }, { ...release, filters: { 'owner/broken': { filter } } }),
      '/not/saved',
      'unsupported',
      'unsupported_query',
    );
  }
});

test('owner parsing rejects unknown selectors, malformed operands and non-native identifiers at exact pointers', () => {
  const cases: [unknown, string, FieldErrorCode][] = [
    [{ owner: null }, '/owner', 'invalid_type'],
    [{ owner: [] }, '/owner', 'invalid_type'],
    [{ owner: {} }, '/owner', 'unsupported'],
    [{ owner: { presence: true, label: { id: label } } }, '/owner', 'unsupported'],
    [{ owner: { presence: false } }, '/owner/presence', 'invalid_format'],
    [{ owner: { presence: 'true' } }, '/owner/presence', 'invalid_type'],
    [{ owner: { label: {} } }, '/owner/label/id', 'required'],
    [{ owner: { label: { id: label.toUpperCase() } } }, '/owner/label/id', 'invalid_format'],
    [{ owner: { label: { id: `${label}\n` } } }, '/owner/label/id', 'invalid_format'],
    [{ owner: { label: { id: 'my-label' } } }, '/owner/label/id', 'invalid_format'],
    [{ owner: { state: { profileId: 'book', stateSetId: 'set', in: [] } } }, '/owner/state/in', 'out_of_range'],
    [
      { owner: { state: { profileId: 'book', stateSetId: 'set', in: ['x', 'x'] } } },
      '/owner/state/in/1',
      'invalid_format',
    ],
    [{ owner: { state: { profileId: 'book', in: ['x'] } } }, '/owner/state/stateSetId', 'required'],
    [{ owner: { state: { stateSetId: 'set', in: ['x'] } } }, '/owner/state/profileId', 'required'],
    [{ owner: { state: { profileId: 'book', stateSetId: 'set' } } }, '/owner/state/in', 'required'],
    [{ owner: { session: { profileId: 'book', lifecycle: 'paused' } } }, '/owner/session/lifecycle', 'invalid_format'],
    [{ owner: { session: { profileId: 'book' } } }, '/owner/session/lifecycle', 'required'],
    [{ owner: { holding: {} } }, '/owner/holding/profileId', 'required'],
  ];
  for (const selector of ['account', 'ownerId', 'client', 'route', 'principal', 'pin', 'a/b~']) {
    cases.push([
      { owner: { [selector]: label } },
      `/owner/${selector.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      'unknown_field',
    ]);
    cases.push([
      { owner: { holding: { profileId: 'book', [selector]: label } } },
      `/owner/holding/${selector.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      'unknown_field',
    ]);
  }
  for (const [family, valid, fields] of [
    ['state', { profileId: 'book', stateSetId: 'set', in: ['x'] }, ['profileId', 'stateSetId']],
    ['session', { profileId: 'book', lifecycle: 'active' }, ['profileId']],
    ['holding', { profileId: 'book', kind: 'physical', status: 'owned' }, ['profileId', 'kind', 'status']],
  ] as const) {
    for (const field of fields) {
      for (const value of ['', 'A', 'schema:Book', 'x/y', 'x\n', 'é', 'a'.repeat(65)]) {
        cases.push([
          { owner: { [family]: { ...valid, [field]: value } } },
          `/owner/${family}/${field}`,
          'invalid_format',
        ]);
      }
      cases.push([{ owner: { [family]: { ...valid, [field]: null } } }, `/owner/${family}/${field}`, 'invalid_type']);
    }
    cases.push([
      { owner: { [family]: { ...valid, releaseDigest: 'digest' } } },
      `/owner/${family}/releaseDigest`,
      'unknown_field',
    ]);
  }
  for (const value of ['X', '', 'x\n', 'a'.repeat(65)]) {
    cases.push([
      { owner: { state: { profileId: 'book', stateSetId: 'set', in: [value] } } },
      '/owner/state/in/0',
      'invalid_format',
    ]);
  }
  cases.push([{ owner: { label: { id: label, name: 'Name' } } }, '/owner/label/name', 'unknown_field']);
  for (const [input, pointer, code] of cases) refuses(() => parseFilter(input), pointer, code);
  expect(
    admit({ owner: { holding: { profileId: 'a'.repeat(64), kind: 'seed-tray.v2', status: 'legacy-unspecified' } } }),
  ).toBeTruthy();
});

test('owner fields and arrays never execute accessors or use inherited required values or holes', () => {
  let calls = 0;
  const getter = {
    get() {
      calls++;
      throw new Error('Must not execute');
    },
  };
  const inherited = Object.create({ profileId: 'book' }) as object;
  Object.assign(inherited, { stateSetId: 'set', in: ['x'] });
  refuses(() => parseFilter({ owner: { state: inherited } }), '/owner/state/profileId', 'required');
  refuses(() => parseFilter({ owner: Object.create({ presence: true }) }), '/owner', 'unsupported');
  const inputs: [unknown, string][] = [
    [Object.defineProperty({}, 'owner', getter), '/owner'],
    [{ owner: Object.defineProperty({}, 'label', getter) }, '/owner/label'],
    [{ owner: { label: Object.defineProperty({}, 'id', getter) } }, '/owner/label/id'],
    [{ owner: { state: { profileId: 'book', stateSetId: 'set', in: new Array(1) } } }, '/owner/state/in/0'],
    [
      { owner: { state: { profileId: 'book', stateSetId: 'set', in: Object.defineProperty(['x'], 0, getter) } } },
      '/owner/state/in/0',
    ],
  ];
  for (const [input, pointer] of inputs) refuses(() => parseFilter(input), pointer, 'invalid_type');
  expect(calls).toBe(0);
  const hidden = Object.defineProperty({ id: label }, 'account', { value: 'other' });
  refuses(() => parseFilter({ owner: { label: hidden } }), '/owner/label/account', 'unknown_field');
});

test('every owner leaf spends exactly one shared leaf and all existing limits survive expansion', () => {
  const leaf = families[0]!;
  expect(admit({ and: Array.from({ length: FILTER_LIMITS.leaves }, () => leaf) })).toBeTruthy();
  refuses(
    () => parseFilter({ and: Array.from({ length: FILTER_LIMITS.leaves + 1 }, () => leaf) }),
    '',
    'out_of_range',
    'unsupported_query',
  );
  expect(admit({ and: [qualified, ...Array.from({ length: 30 }, () => leaf)] })).toBeTruthy();
  refuses(
    () => parseFilter({ and: [qualified, ...Array.from({ length: 31 }, () => leaf)] }),
    '',
    'out_of_range',
    'unsupported_query',
  );
  expect(admit({ or: Array.from({ length: FILTER_LIMITS.or }, () => leaf) })).toBeTruthy();
  refuses(
    () => parseFilter({ or: Array.from({ length: FILTER_LIMITS.or + 1 }, () => leaf) }),
    '/or',
    'out_of_range',
    'unsupported_query',
  );
  const state = (count: number) => ({
    owner: {
      state: { profileId: 'book', stateSetId: 'set', in: Array.from({ length: count }, (_, i) => `state-${i}`) },
    },
  });
  expect(admit(state(FILTER_LIMITS.in))).toBeTruthy();
  refuses(() => parseFilter(state(FILTER_LIMITS.in + 1)), '/owner/state/in', 'out_of_range', 'unsupported_query');
  const deep = { and: [{ or: [{ not: { and: [leaf] } }] }] };
  expect(admit(deep)).toEqual(deep);
  refuses(() => parseFilter({ and: [deep] }), '/and/0/and/0/or/0/not', 'out_of_range', 'unsupported_query');
  refuses(() => parseFilter({ not: { not: leaf } }), '/not', 'unsupported', 'unsupported_query');
  const expanded = {
    ...release,
    filters: { 'owner/pair': { filter: { and: [leaf, leaf] } }, 'owner/deep': { filter: deep } },
  };
  refuses(
    () => admit({ and: [deep, { saved: 'owner/deep' }] }, expanded),
    '/and/0/and/0/or/0/not',
    'out_of_range',
    'unsupported_query',
  );
  refuses(
    () => admit({ and: [{ saved: 'owner/deep' }] }, expanded),
    '/and/0/saved',
    'out_of_range',
    'unsupported_query',
  );
  refuses(
    () => admit({ and: [...Array.from({ length: 31 }, () => leaf), { saved: 'owner/pair' }] }, expanded),
    '',
    'out_of_range',
    'unsupported_query',
  );
});

test('complete expanded AST traversal retains negative owner and catalogue dependencies with native identity', () => {
  const mixed: FilterDocument = admit({
    and: [book, { not: { saved: 'owner/family-9' } }, { not: qualified }, { saved: 'owner/family-1' }],
  });
  const nodes = [...walkFilter(mixed)];
  expect(nodes).toHaveLength(7);
  expect(nodes[0]).toBe(mixed);
  if (!('and' in mixed)) throw new Error('Expected and');
  expect(nodes[1]).toBe(mixed.and[0]);
  expect(nodes[2]).toBe(mixed.and[1]);
  const leaves = nodes.filter((node) => 'owner' in node || 'statement' in node || 'type' in node);
  expect(leaves).toEqual([book, families[9], qualified, families[1]]);
  expect(nodes.some((node) => 'saved' in node)).toBe(false);
  expect(
    leaves.flatMap((node) =>
      'statement' in node
        ? [node.statement.property, ...node.statement.qualifiers!.map((qualifier) => qualifier.property)]
        : [],
    ),
  ).toEqual(['schema:genre', 'rezics:role']);
  for (const leaf of families) expect([...walkFilter(admit({ not: leaf }))][1]).toEqual(leaf);
});
