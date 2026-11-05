import { expect, test } from 'bun:test';
import { createIdentityRatingCommitParticipant } from '../../src/semantic/identity-rating-commit-participant.ts';

const id = '01a1a8fe-b84b-749c-a651-806639d32394';

function operand(pending: { pending_job: string | null; pending_epoch: string | null }) {
  const mapping = JSON.stringify({
    sourceOwners: [{ partition_no: 2054, epoch: 1, write_state: 'active' }],
    sourceRows: [
      {
        subject_id: id,
        original: id,
        control_partition: 2054,
        control_group: id,
        epoch: '1',
        owner_epoch: 1,
        dirty_revision: '1',
        captured_revision: '1',
        terminal: id,
        closure_state: 'legacy',
        closure_immediate: null,
        current_target: null,
        source_revision: '0',
        closure_enrollment: null,
        closure_generation: null,
        closure_incarnation: null,
        closure_install_transaction: null,
        closure_registration_transaction: null,
        closure_export_transaction: null,
      },
    ],
    controlOwners: [{ partition_no: 2054, epoch: 1, write_state: 'active' }],
    pendingRows: [{ partition_no: 2054, terminal: id, ...pending }],
    currentRows: [
      {
        partition_no: 2054,
        terminal: id,
        published_epoch: '1',
        owner_epoch: 1,
        generation: '87521694-73eb-4163-9dc3-0c767287a6e2',
        closure_state: 'open',
        closure_incarnation: 'd4b454ee-9369-4454-9e55-78bd3a845220',
        requested_original: id,
        directory_state: 'legacy',
        directory_enrollment: null,
        directory_incarnation: null,
        directory_install: null,
        directory_export: null,
        directory_revision: null,
        directory_owner: null,
        registration_transaction: null,
        redirected: false,
      },
    ],
  });
  return {
    version: 1 as const,
    requestedOriginalId: id,
    canonicalTerminalId: id,
    sourceIdentities: [id],
    sourceHomes: [2054],
    controlLocators: [{ partition: 2054, group: id }],
    evidence: JSON.stringify({ mapping, subjects: [{ subject_id: id, visibility: 'visible' }] }),
  };
}

test('preparation admits reviewed evidence whose control group has no pending job', () => {
  expect(() =>
    createIdentityRatingCommitParticipant().prepare(operand({ pending_job: null, pending_epoch: null })),
  ).not.toThrow();
});

test('preparation rejects a pending job without its epoch', () => {
  expect(() =>
    createIdentityRatingCommitParticipant().prepare(
      operand({ pending_job: '01900000-0000-7000-8000-000000000001', pending_epoch: null }),
    ),
  ).toThrow(TypeError);
});
