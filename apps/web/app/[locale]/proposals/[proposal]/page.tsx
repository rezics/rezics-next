import type { Metadata } from 'next';
import { signInPath } from '../../../../features/auth/paths.ts';
import { readAgents } from '../../../../features/manage/read.ts';
import { ProposalsFailure } from '../../../../features/proposals/failure.tsx';
import { ProposalPage } from '../../../../features/proposals/proposal-page.tsx';
import { readProposal, readTargetNames } from '../../../../features/proposals/read.ts';
import { isUuid } from '../../../../features/proposals/types.ts';
import { shellReader } from '../../../../features/shell/communities-read.ts';
import { PageContainer } from '../../../../features/shell/page.tsx';
import { localizedPath } from '../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('proposals', [await requestLocale()]);
  return { title: t.title, robots: { index: false } };
}

/**
 * A correction at its durable address. `?revision=N` links to a revision a
 * reviewer or notification named; the page says when a later one replaced it.
 */
export default async function ProposalRoute({ params, searchParams }: {
  params: Promise<{ proposal: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ proposal }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const messages = await getMessages('proposals', locale);
  const path = `/proposals/${proposal}`;
  const failure = (kind: Parameters<typeof ProposalsFailure>[0]['failure']) => <PageContainer>
    <ProposalsFailure failure={kind} signInHref={signInPath(localizedPath(path, locale))}
      retryHref={path} locale={locale} messages={messages} /></PageContainer>;
  if (!isUuid(proposal)) return failure('missing');
  const reader = await shellReader();
  const read = await readProposal(reader.main, proposal, reader.actingSubject);
  if (!read.ok) return failure(read.failure === 'sign-in' && !reader.signedIn ? 'signed-out' : read.failure);
  const view = read.data;
  const people = [view.proposal.proposer, ...view.timeline.map(entry => entry.actor)];
  const [names, agents] = await Promise.all([readTargetNames(reader.main, reader.actingSubject,
    [view.proposal.target.resource], locale), readAgents(reader.anonymous, people)]);
  const linked = typeof query.revision === 'string' && /^[1-9][0-9]{0,8}$/.test(query.revision)
    ? Number(query.revision) : null;
  return <PageContainer><ProposalPage initial={view} target={names[view.proposal.target.resource] ?? null}
    agents={agents} actingSubject={reader.actingSubject} now={Date.now()} locale={locale} messages={messages}
    linkedRevision={linked} /></PageContainer>;
}
