import { createHash } from 'node:crypto';
import { accountAgentId, accountAgentsForSubjects } from '../semantic/agents.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SummaryReaderDependencies } from '../semantic/summaries.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { routeOf } from '../route/route.ts';

type Account = {
  id: string;
  revision: string;
  handle: string | null;
  agent: string | null;
  agentReceipt: string | null;
};

/** Derived IDs are lookup keys only. A stored exact reciprocal link AND installed native
 * identity publication must prove the subject; a formula or an Account UUID never does.
 * The caller compares two observations around anonymous subject hydration.
 */
export async function readAccountContextBindings(deps: SummaryReaderDependencies, accounts: readonly Account[]) {
  if (accounts.length > 100) throw new RangeError('Account context accepts at most 100 native accounts');
  requireAccessDeadline(deps.deadline);
  const candidates = accounts.map((account) => account.agent ?? accountAgentId(account.id));
  const native = await withReadTransaction(deps.pool, async (client) => {
    const links = await accountAgentsForSubjects(client, candidates);
    const verified = accounts.filter((account) => account.agent && account.agentReceipt);
    const pages = verified.length
      ? (
          await client.query<{ subject: string; account: string; receipt: string }>(
            `SELECT subject_id::text AS subject, account_id::text AS account,
             verification_receipt_id::text AS receipt FROM access.agent_page
           WHERE (route, subject_id) IN (SELECT * FROM unnest($1::integer[], $2::uuid[]))`,
            [verified.map((account) => routeOf(account.agent!)!), verified.map((account) => account.agent)],
          )
        ).rows
      : [];
    return { links, pages };
  });
  const originals = [
    ...new Set(accounts.flatMap((account, index) => [accountAgentId(account.id), candidates[index]!])),
  ];
  const mappings = new Map<string, Awaited<ReturnType<typeof readIdentityMappings>>[number]>();
  for (let offset = 0; offset < originals.length; offset += 100) {
    requireAccessDeadline(deps.deadline);
    const group = originals.slice(offset, offset + 100);
    (await readIdentityMappings(deps.pool, group)).forEach((mapping, index) => mappings.set(group[index]!, mapping));
  }
  const result = new Map<string, { id: string; source: string }>();
  accounts.forEach((account, index) => {
    const candidate = candidates[index]!;
    const link = native.links.get(candidate);
    const original = accountAgentId(account.id);
    const verified = account.agent !== null;
    if (
      !link ||
      link.account !== account.id ||
      link.route !== routeOf(account.id) ||
      link.agent_id !== original ||
      link.subject !== candidate ||
      link.verified !== verified ||
      (verified
        ? link.receipt_id !== account.agentReceipt ||
          !account.agentReceipt ||
          !native.pages.some(
            (page) =>
              page.subject === candidate && page.account === account.id && page.receipt === account.agentReceipt,
          )
        : link.receipt_id !== null)
    )
      return;
    const mapping = mappings.get(original),
      target = mappings.get(candidate);
    if (
      mapping?.state !== 'mapped' ||
      target?.state !== 'mapped' ||
      mapping.epoch <= 0n ||
      mapping.epoch !== target.epoch ||
      mapping.terminal !== candidate ||
      target.terminal !== candidate
    )
      return;
    result.set(account.id, {
      id: candidate,
      source: createHash('sha256')
        .update(
          JSON.stringify([
            account.id,
            account.revision,
            account.handle,
            candidate,
            link.receipt_id,
            mapping.epoch.toString(),
          ]),
        )
        .digest('hex'),
    });
  });
  requireAccessDeadline(deps.deadline);
  return result;
}
