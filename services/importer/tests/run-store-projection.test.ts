import { expect, test } from 'bun:test';
import { RunStore, type SourceProjection } from '../src/run-store';

test('sanitized source projections roundtrip without inventing semantic statements', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  try {
    const run = store.begin('bangumi');
    if (run === 'busy') throw new Error('Expected fresh run');
    const projection: SourceProjection = {
      sourceKind: 'bangumi',
      normalizedRecord: {
        id: 1,
        type: 1,
        name: 'Example',
        summary: 'Full allowed summary',
        images: { large: 'https://lain.bgm.tv/pic/cover/l/x.jpg' },
      },
    };
    store.stage(run, {
      row: {
        source: 'bangumi',
        recordKey: '1',
        recordRevision: 'unversioned',
        digest: 'a'.repeat(64),
        converter_revision: 'test@1',
        state: 'present',
      },
      projection,
    });
    expect(store.key('bangumi', '1', run).staged?.projection).toEqual(projection);
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    expect(store.key('bangumi', '1', run).staged?.projection).toEqual(projection);
  } finally {
    store.close();
  }
});

function sourceStore() {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  const run = store.begin('bangumi');
  if (run === 'busy') throw new Error('Expected fresh run');
  const row = {
    source: 'bangumi',
    recordKey: '1',
    recordRevision: 'unversioned',
    digest: 'a'.repeat(64),
    converter_revision: 'test@1',
    state: 'present' as const,
  };
  return { store, run, row };
}

test('source records preserve JSON values and null-prototype converter dictionaries across reopening', () => {
  const { store, run, row } = sourceStore();
  try {
    const dictionary = Object.assign(Object.create(null), {
      __proto__: null,
      title: '雪',
      nested: [null, true, 1.25, { text: 'Full summary' }],
    });
    Object.defineProperty(dictionary, '__proto__', { value: { safe: true }, enumerable: true });
    const projection: SourceProjection = { sourceKind: 'bangumi', normalizedRecord: dictionary };
    store.stage(run, { row, projection });
    const reopened = store.reopen(run);
    expect(store.seal(reopened, { complete: true }).status).toBe('ready');
    store.classify(reopened, '1', {
      commands: [],
      omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '9007199254740993' }],
    });
    expect(store.key('bangumi', '1', reopened).staged?.projection).toEqual(projection);
    expect(store.finalize(reopened, 8)).toBe('complete');
    expect(store.key('bangumi', '1', reopened).staged?.projection).toEqual(projection);
  } finally {
    store.close();
  }
});

test('malformed source projections reject without executing descriptors or retaining private input', () => {
  const { store, run, row } = sourceStore();
  let invoked = 0;
  const secret = 'PRIVATE_RAW_DUMP_SENTINEL';
  const getter = Object.defineProperty({}, 'rawdump', {
    enumerable: true,
    get() {
      invoked++;
      return secret;
    },
  });
  const setter = Object.defineProperty({}, 'rawdump', {
    enumerable: true,
    set(_value: unknown) {
      invoked++;
    },
  });
  const hidden = Object.defineProperty({}, 'rawdump', { value: secret });
  const toJSON = {
    toJSON() {
      invoked++;
      return secret;
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const outerGetter = Object.defineProperty({ sourceKind: 'bangumi' }, 'normalizedRecord', {
    enumerable: true,
    get() {
      invoked++;
      return secret;
    },
  });
  const outerKindGetter = Object.defineProperty({ normalizedRecord: {} }, 'sourceKind', {
    enumerable: true,
    get() {
      invoked++;
      return 'bangumi';
    },
  });
  const toJSONGetter = Object.defineProperty({}, 'toJSON', {
    enumerable: true,
    get() {
      invoked++;
      return () => secret;
    },
  });
  const arrayGetter = Object.defineProperty([null], '0', {
    enumerable: true,
    get() {
      invoked++;
      return secret;
    },
  });
  const arrayToJSON = Object.defineProperty([], 'toJSON', {
    value() {
      invoked++;
      return secret;
    },
  });
  const invalid: unknown[] = [
    [],
    null,
    { sourceKind: 'unknown', normalizedRecord: {} },
    { sourceKind: 1, normalizedRecord: {} },
    { sourceKind: 'bangumi', normalizedRecord: {}, rawdump: secret },
    { sourceKind: 'bangumi' },
    outerGetter,
    outerKindGetter,
    Object.defineProperty({ sourceKind: 'bangumi' }, 'normalizedRecord', { value: secret }),
    Object.assign({ sourceKind: 'bangumi', normalizedRecord: {} }, { [Symbol('rawdump')]: secret }),
    ...[
      getter,
      setter,
      hidden,
      toJSON,
      toJSONGetter,
      arrayGetter,
      arrayToJSON,
      Object.defineProperty(Object.create(null), 'private', { value: secret }),
      Object.defineProperty(Object.create(null), 'private', {
        enumerable: true,
        get() {
          invoked++;
          return secret;
        },
      }),
      cycle,
      new Date(),
      new Map(),
      new Array(2),
      { [Symbol('rawdump')]: secret },
      { value: undefined },
      { value: Infinity },
      { value: NaN },
      { value: 1n },
      { value: Symbol('rawdump') },
      { value: () => secret },
      Object.assign([], { rawdump: secret }),
      'x'.repeat(65536),
      '\u0000'.repeat(12000),
    ].map((normalizedRecord) => ({ sourceKind: 'bangumi', normalizedRecord })),
  ];
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { child: deep };
  invalid.push({ sourceKind: 'bangumi', normalizedRecord: deep });
  try {
    for (const projection of invalid) {
      expect(() => store.stage(run, { row, projection: projection as SourceProjection })).toThrow();
      expect(invoked).toBe(0);
      expect(store.key('bangumi', '1', run).staged).toBeNull();
    }
    const persisted = JSON.stringify(store.database.query('SELECT * FROM run_entries').all());
    expect(persisted).not.toContain(secret);
    expect(store.seal(run, { complete: true }).supplied).toBe(0);
  } finally {
    store.close();
  }
});

test('default staging still validates semantic statement fixtures', () => {
  const store = new RunStore(':memory:');
  try {
    const run = store.begin('bangumi');
    if (run === 'busy') throw new Error('Expected fresh run');
    const row = {
      source: 'bangumi',
      recordKey: '1',
      recordRevision: 'unversioned',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    };
    expect(() => store.stage(run, { row, projection: [{ property: { id: 'schema:name' } }] as never })).toThrow();
    expect(() =>
      store.stage(run, { row, projection: { sourceKind: 'bangumi', normalizedRecord: {} } as never }),
    ).toThrow();
    store.stage(run, { row, projection: [] });
    expect(store.key('bangumi', '1', run).staged?.projection).toEqual([]);
  } finally {
    store.close();
  }
});

test('source JSON bounds use serialized UTF-8 bytes and retain JSON scalars', () => {
  for (const normalizedRecord of [null, true, 42, '雪', 'x'.repeat(65534)]) {
    const { store, run, row } = sourceStore();
    try {
      const projection: SourceProjection = { sourceKind: 'bangumi', normalizedRecord };
      store.stage(run, { row, projection });
      expect(store.key('bangumi', '1', run).staged?.projection).toEqual(projection);
    } finally {
      store.close();
    }
  }
  for (const normalizedRecord of ['x'.repeat(65535), '雪'.repeat(21845)]) {
    const { store, run, row } = sourceStore();
    try {
      expect(() => store.stage(run, { row, projection: { sourceKind: 'bangumi', normalizedRecord } })).toThrow();
    } finally {
      store.close();
    }
  }
});

test('opaque fenced revisions retain exact decimal bytes when proofs advance', () => {
  const store = new RunStore(':memory:');
  try {
    const begun = store.begin('bangumi');
    if (begun === 'busy') throw new Error('Expected fresh run');
    let run = begun;
    const row = {
      source: 'bangumi',
      recordKey: '1',
      recordRevision: 'unversioned',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    };
    store.stage(run, { row, projection: [] });
    store.seal(run, { complete: true });
    for (const securityRevision of [0, 1, '', '0', '01', '-1', '1.5', '1e3', '1\n', '1'.repeat(257)]) {
      expect(() =>
        store.classify(run, '1', {
          commands: [],
          omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision } as never],
        }),
      ).toThrow();
      expect(store.key('bangumi', '1', run).acknowledged).toBeNull();
    }
    for (const securityRevision of ['9', '10', '9007199254740992', '9007199254740993', '9'.repeat(256)]) {
      store.classify(run, '1', {
        commands: [],
        omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision }],
      });
      run = store.reopen(run);
      expect(store.key('bangumi', '1', run).omissions[0]?.securityRevision).toBe(securityRevision);
    }
    store.classify(run, '1', {
      commands: [],
      omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '10' }],
    });
    expect(store.key('bangumi', '1', run).omissions[0]?.securityRevision).toBe('9'.repeat(256));
  } finally {
    store.close();
  }
});
