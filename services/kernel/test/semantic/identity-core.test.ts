import { expect, test } from 'bun:test';
import {
  classifyIdentityMappings,
  classifyIdentityRemainder,
  comparableIdentityEvidence,
  identityEpochChangeTerminal,
  identityMappingObservationValue,
  serializeIdentityValue,
  type IdentityMappingEvidence,
  type IdentitySourceEvidence,
  type IdentityControlEvidence,
} from '../../src/semantic/identity-core/index.ts';

const job = { jobId: 'job', epoch: 7n };
const request = [{ original: 'saved', sourceHome: 2 }];
const unavailable = { state: 'unavailable', reason: 'bootstrap' };
function evidence(): IdentityMappingEvidence {
  return {
    sourceOwners: [{ partition_no: 2, epoch: 3, position: 100n, write_state: 'active' }],
    controlOwners: [{ partition_no: 5, epoch: 4, position: 200n, write_state: 'active' }],
    sourceRows: [
      {
        subject_id: 'saved',
        original: 'saved',
        control_partition: 5,
        control_group: 'canonical',
        epoch: '7',
        owner_epoch: 3,
        dirty_revision: '9',
        captured_revision: '9',
        terminal: 'canonical',
        closure_state: 'active',
        closure_immediate: 'canonical',
        current_target: 'canonical',
        source_revision: '9',
        closure_enrollment: 'enroll',
        closure_generation: 'generation',
        closure_incarnation: 'incarnation',
        closure_install_transaction: 'install',
        closure_registration_transaction: 'register',
        closure_export_transaction: 'export',
      },
    ],
    currentRows: [
      {
        partition_no: 5,
        terminal: 'canonical',
        requested_original: 'saved',
        redirected: false,
        owner_epoch: 4,
        closure_state: 'open',
        directory_state: 'installed',
        directory_enrollment: 'enroll',
        generation: 'generation',
        closure_incarnation: 'incarnation',
        directory_incarnation: 'incarnation',
        directory_install: 'install',
        registration_transaction: 'register',
        directory_export: 'export',
        directory_owner: 3,
        directory_revision: '9',
        published_epoch: '11',
      },
    ],
    pendingRows: [],
  };
}
const resolve = (e: IdentityMappingEvidence, installed: typeof job | null = null) =>
  classifyIdentityMappings(request, e, installed)[0];

test('saved originals preserve publication epoch, pending and exact absence without self fallback', () => {
  const e = evidence();
  expect(resolve(e)).toEqual({ state: 'mapped', original: 'saved', terminal: 'canonical', epoch: 11n });
  const pending = {
    ...e,
    pendingRows: [{ partition_no: 5, terminal: 'canonical', pending_job: 'job', pending_epoch: '7' }],
  };
  expect(resolve(pending)).toEqual({ state: 'pending', original: 'saved', job });
  expect(resolve(pending, job)).toEqual({ state: 'mapped', original: 'saved', terminal: 'canonical', epoch: 7n });
  for (const installed of [
    { ...job, jobId: 'other' },
    { ...job, epoch: 8n },
  ])
    expect(resolve(pending, installed)?.state).toBe('pending');
  expect(resolve({ ...pending, sourceRows: [{ ...e.sourceRows[0]!, epoch: '6' }] }, job)?.state).toBe('pending');
  expect(resolve({ ...e, sourceRows: [] })).toEqual({ state: 'absent' });
  expect(resolve({ ...e, sourceOwners: [] })).toEqual({ state: 'unavailable', reason: 'missing-owner' });
  expect(resolve({ ...e, controlOwners: [] })).toEqual({ state: 'unavailable', reason: 'missing-owner' });
  for (const field of ['sourceOwners', 'controlOwners'] as const) {
    expect(resolve({ ...e, [field]: [{ ...e[field][0]!, write_state: 'moved' }] })).toEqual({
      state: 'unavailable',
      reason: 'moved-owner',
    });
    expect(resolve({ ...e, [field]: [{ ...e[field][0]!, write_state: 'draining' }] })).toEqual(unavailable);
  }
  expect(classifyIdentityMappings([], e)).toEqual([]);
  expect(() => classifyIdentityMappings(Array(101).fill(request[0]), e)).toThrow(RangeError);
});

test('exact requested original, owner, source revision, closure and installed directory remain mandatory', () => {
  const e = evidence();
  const badSources: Partial<IdentitySourceEvidence>[] = [
    { original: null },
    { control_partition: null },
    { control_group: 'other' },
    { epoch: '0' },
    { owner_epoch: 2 },
    { dirty_revision: '10' },
    { closure_state: 'closed' },
    { closure_immediate: 'other' },
    { source_revision: '8' },
    { closure_enrollment: 'other' },
    { closure_generation: 'other' },
    { closure_incarnation: 'other' },
    { closure_install_transaction: 'other' },
    { closure_registration_transaction: 'other' },
    { closure_export_transaction: 'other' },
  ];
  for (const patch of badSources)
    expect(resolve({ ...e, sourceRows: [{ ...e.sourceRows[0]!, ...patch }] })).toEqual(unavailable);
  const badControls: Partial<IdentityControlEvidence>[] = [
    { requested_original: 'other' },
    { partition_no: 9 },
    { terminal: 'other' },
    { redirected: true },
    { owner_epoch: 3 },
    { closure_state: 'closed' },
    { directory_state: 'pending' },
    { directory_enrollment: 'other' },
    { generation: 'other' },
    { closure_incarnation: 'other' },
    { directory_incarnation: 'other' },
    { directory_install: 'other' },
    { registration_transaction: null },
    { directory_export: 'other' },
    { directory_owner: 2 },
    { directory_revision: null },
  ];
  for (const patch of badControls)
    expect(resolve({ ...e, currentRows: [{ ...e.currentRows[0]!, ...patch }] })).toEqual(unavailable);
  expect(resolve({ ...e, currentRows: [] })).toEqual(unavailable);
  const legacy = { ...e, sourceRows: [{ ...e.sourceRows[0]!, closure_state: 'legacy' }] };
  expect(resolve(legacy)?.state).toBe('mapped');
  expect(resolve({ ...legacy, sourceRows: [{ ...legacy.sourceRows[0]!, current_target: null }] })).toEqual(unavailable);
  expect(
    resolve({
      ...e,
      sourceRows: [
        {
          ...e.sourceRows[0]!,
          terminal: 'saved',
          control_group: 'saved',
          closure_state: 'legacy',
          current_target: 'saved',
        },
      ],
    }),
  ).toEqual(unavailable);
});

test('immutable merge, unmerge and repoint preserve original references and constant remainder semantics', () => {
  for (const [intent, expected] of [
    [{ kind: 'merge', survivor: 'target' }, ['target', 'target', 'target']],
    [{ kind: 'unmerge', original: 'saved' }, ['saved', 'remainder', 'other']],
    [{ kind: 'repoint', original: 'saved', terminal: 'target' }, ['target', 'remainder', 'other']],
  ] as const) {
    Object.freeze(intent);
    expect(
      [
        ['saved', 'saved'],
        ['member', 'saved'],
        ['other', 'other'],
      ].map(([original, previous]) => identityEpochChangeTerminal(intent, 'remainder', original!, previous!)),
    ).toEqual(expected);
  }
  const intent = Object.freeze({ kind: 'unmerge', original: 'saved' } as const);
  const source = Object.freeze({
    input_original: 'saved',
    terminal: 'saved',
    observed_count: '2',
    remainder_terminal: 'member',
  });
  expect(classifyIdentityRemainder(intent, [source])).toEqual({ state: 'ready', terminal: 'member' });
  expect(classifyIdentityRemainder(intent, [{ ...source, remainder_terminal: null }])).toEqual({
    state: 'unavailable',
  });
  expect(classifyIdentityRemainder(intent, [{ ...source, observed_count: '4098' }])).toEqual({ state: 'overflow' });
  expect(classifyIdentityRemainder({ kind: 'repoint', original: 'saved', terminal: 'target' }, [source])).toEqual({
    state: 'stale',
  });
  expect(classifyIdentityRemainder(intent, [])).toEqual({ state: 'unavailable' });
  expect(identityEpochChangeTerminal(intent, null, 'member', 'saved')).toBe('saved');
});

test('observation and double-collection encodings preserve exact bigint bytes and ignore only owner positions', () => {
  const mappings = [
    { state: 'mapped', original: 'saved', terminal: 'canonical', epoch: 9007199254740993n },
    { state: 'pending', original: 'saved', job },
    { state: 'absent' },
    ...(['bootstrap', 'missing-owner', 'moved-owner'] as const).map(
      (reason) => ({ state: 'unavailable', reason }) as const,
    ),
  ] as const;
  expect(JSON.stringify(mappings.map(identityMappingObservationValue))).toBe(
    '[["mapped","saved","canonical","9007199254740993"],["pending","saved","job","7"],["absent"],["unavailable","bootstrap"],["unavailable","missing-owner"],["unavailable","moved-owner"]]',
  );
  const e = evidence();
  const prior = JSON.stringify(
    {
      ...e,
      sourceOwners: e.sourceOwners.map(({ position, ...v }) => v),
      controlOwners: e.controlOwners.map(({ position, ...v }) => v),
    },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  expect(comparableIdentityEvidence(e)).toBe(prior);
  expect(comparableIdentityEvidence({ ...e, sourceOwners: [{ ...e.sourceOwners[0]!, position: 999n }] })).toBe(prior);
  expect(comparableIdentityEvidence({ ...e, controlOwners: [{ ...e.controlOwners[0]!, epoch: 5 }] })).not.toBe(prior);
  expect(serializeIdentityValue({ epoch: 9007199254740993n })).toBe('{"epoch":"9007199254740993"}');
});
