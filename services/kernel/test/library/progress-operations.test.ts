import { expect, test } from 'bun:test';
import { createProgressOperationApplication } from '../../src/library/application/index.ts';
import {
  EMPTY_COLLECTION_AUTHORIZATION_PREPARATION,
  emptyProgressOperationCatalog,
} from '../../src/library/contract/index.ts';
import type { LibraryActor } from '../../src/library/contract/actors.ts';
import { createProgressOperationCatalog } from '../../src/library/adapters/progress-statements.ts';
import { sessionCommandPlan, sessionSourceWork } from '../../src/library/session-operation-bounds.ts';

const accountId = '00000000-0000-7000-8000-000000000001';
const subjectId = '00000000-0000-7000-8000-000000000003';
const actor: LibraryActor = {
  kind: 'account',
  accountId,
  clientId: '00000000-0000-7000-8000-000000000005',
  scopes: ['collection:read'],
  requestedBy: null,
  authnEpoch: 1,
};

test('progress admission withholds identity disclosure after a closed deadline and keeps retry operands', async () => {
  let disclosureReads = 0;
  const application = createProgressOperationApplication({
    progressCatalog: emptyProgressOperationCatalog(),
    authorization: {
      async admitCollectionRead() {
        return { authorized: true };
      },
      async fenceAccount() {},
      isLifecycleDenied() {
        return false;
      },
      async commandAuthorization() {
        return {};
      },
      deadlineClient: (client) => client,
      within: (_deadline, work) => work(),
      specializeCollectionList() {
        return { status: 'unavailable' as const };
      },
      collectionAuthorizationPreparation() {
        return EMPTY_COLLECTION_AUTHORIZATION_PREPARATION;
      },
    },
    identityDisclosure: {
      async readRelease() {
        return null;
      },
      async readOriginalTerminal() {
        disclosureReads += 1;
        return { original: subjectId, terminal: subjectId };
      },
      async readActiveRelease() {
        return null;
      },
      initiatorCommitment() {
        return 'initiator';
      },
    },
  });

  const closed = await application.admit({ actor, deadline: Date.now() - 1, subjectId });
  expect(closed.admitted).toBe(false);
  expect(closed.admission.terms[0]?.name).toBe('deadline');
  expect(disclosureReads).toBe(0);

  const original = {
    accountId,
    clientId: actor.clientId,
    requestedBy: null,
    kind: 'progress_session.record',
    key: 'rk1.1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    input: { add: ['u1'], remove: [] },
  };
  const first = application.planCommand('record', original, 1, true);
  const second = application.planCommand('record', original, 1, true);
  expect(second.original).toEqual(first.original);
  expect(second.total).toEqual(first.total);
  expect(first.original.input).toEqual({ add: ['u1'], remove: [] });
});

test('native progress catalog keeps Access and Semantic SQL and unknown COMMIT in the inclusive command bound', () => {
  const catalog = createProgressOperationCatalog();
  expect(catalog.access.accountRead.sql).toContain('FROM access.account');
  expect(catalog.access.accountShare.sql).toContain('FOR SHARE');
  expect(catalog.semantic.releaseExists.sql).toContain('definition_release');
  expect(catalog.semantic.releaseActive.sql).toContain('definition_activation');
  expect(catalog.semantic.mappingOwners.sql.length).toBeGreaterThan(0);
  expect(catalog.semantic.subjectReference.sql).toContain('semantic.redirect');
  const plan = sessionCommandPlan(
    'complete',
    {
      accountId,
      clientId: actor.clientId,
      requestedBy: null,
      kind: 'progress_session.complete',
      key: 'rk1.1.cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      input: {},
    },
    1,
  );
  expect(plan.total.engineRequests).toBe(0);
  expect(plan.total.statements).toBeGreaterThan(sessionSourceWork(subjectId, true).statements);
  expect(plan.original.accountId).toBe(accountId);
});
