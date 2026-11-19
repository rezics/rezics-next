import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import {
  createAgentVerificationCommands,
  readAgentVerificationWorkflowRequest,
} from '../../src/access/agent-verification.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT_RESOURCE } from '../../src/semantic/contract/global-context.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { runAccountIdentityVerification } from './account-identity-publication.ts';
import { admittedAccess, authenticateAccount } from './admitted-access.ts';

const actions = ['account:update', 'account:verify_agent', 'subject:create'];

export async function publishVerifiedAgentFixture(
  pool: Pool,
  workClient: WorkClient,
  accountId: string,
  catalogueSubjectId: string,
  labels: Record<string, string>,
) {
  const reviewer = newId(routeOf(accountId)!);
  await pool.query(
    `INSERT INTO access.account(route, account_id, kind, handle, state, transaction_id)
     VALUES ($1, $2, 'actor', $3, 'active', $2)`,
    [routeOf(reviewer), reviewer, `reviewer_${reviewer.replaceAll('-', '')}`],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $2, 'account:update', '(,)', $2),
            ($3, $4, $7, 'subject:create', '(,)', $7),
            ($5, $6, $7, 'account:verify_agent', '(,)', $7)`,
    [
      routeOf(accountId),
      accountId,
      GLOBAL_CONTEXT_RESOURCE.route,
      GLOBAL_CONTEXT_RESOURCE.id,
      PLATFORM_RESOURCE.route,
      PLATFORM_RESOURCE.id,
      reviewer,
    ],
  );

  const access = admittedAccess({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  const context = async (id: string, scopes: string[]) => {
    const deadline = Date.now() + 30_000;
    const actor = await authenticateAccount(
      access,
      { pool, deadline },
      { accountId: id, clientId: 'verified-agent-fixture', scopes },
    );
    return { actor, pool, deadline };
  };
  const editor = await context(reviewer, ['subject:create']);
  const key = randomUUID();
  await createSubject(pool, {
    actor: editor.actor,
    target: { route: routeOf(catalogueSubjectId)!, id: catalogueSubjectId },
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Person', labels },
    release: { digest: bundledDigest, release: bundledRelease },
    deadline: editor.deadline,
    authorization: await accessCommandAuthorization(
      access,
      editor.actor,
      'subject:create',
      GLOBAL_CONTEXT_RESOURCE,
      editor,
      () => new Error('Catalogue fixture creation denied'),
    ),
  });

  const commands = createAgentVerificationCommands({ pool, access, clock: () => new Date() });
  const request = await commands.request(await context(accountId, ['account:update']), {
    accountId,
    subject: catalogueSubjectId,
    statement: 'I represent this catalogue identity',
    links: [],
    key: randomUUID(),
  });
  const approval = await commands.approve(await context(reviewer, ['account:verify_agent']), {
    requestId: request.value.id,
    key: randomUUID(),
  });
  const receiptId = approval.value.decisionReceiptId;
  if (!receiptId) throw new Error('Verification approval did not return a receipt');
  await runAccountIdentityVerification(pool, workClient, request.value.id, receiptId);
  const decision = await readAgentVerificationWorkflowRequest(pool, request.value.id);
  if (decision?.state !== 'approved' || decision.decisionReceiptId !== receiptId)
    throw new Error('Verification workflow did not publish the approved decision');
  return { ...decision, receiptId };
}
