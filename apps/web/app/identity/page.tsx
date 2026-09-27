import { Card, CardContent } from '@rezics/ui/card';
import { redirect } from 'next/navigation';
import { agentOptions } from '../../features/auth/acting-identity.ts';
import { AgentPicker, type AgentPickerNotice } from '../../features/auth/agent-picker.tsx';
import { safeReturnPath, signInPath } from '../../features/auth/paths.ts';
import { readSession, sessionDiscovery } from '../../features/auth/session.ts';
import { PageContainer } from '../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../i18n/server.ts';

const reported = new Set(['invalid', 'stale-default', 'default-not-saved', 'unavailable'] as const);

export default async function IdentityPage({ searchParams }: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  const next = safeReturnPath(query.next, '/');
  const session = await readSession();
  if (!session) redirect(signInPath(`/identity?next=${encodeURIComponent(next)}`));
  const discovery = await sessionDiscovery();
  const error = [...reported].find(kind => kind === query.error);
  const notice: AgentPickerNotice | null = error ? { kind: error }
    : session.agent.status === 'ineligible' ? { kind: 'ineligible', previous: session.agent.previous }
      : discovery ? null : { kind: 'unavailable' };
  return <PageContainer className="max-w-xl sm:py-12"><Card><CardContent>
    <AgentPicker options={discovery ? agentOptions(discovery) : null}
      current={session.agent.status === 'selected' ? session.agent.agent.iri : null}
      preferred={discovery?.preferredActingSubject ?? null}
      preferenceRevision={discovery?.preferenceRevision ?? null}
      next={next} notice={notice} messages={await getMessages('auth', await requestLocale())} />
  </CardContent></Card></PageContainer>;
}
