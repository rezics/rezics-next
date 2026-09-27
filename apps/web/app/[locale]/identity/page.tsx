import { Card, CardContent } from '@rezics/ui/card';
import { redirect } from 'next/navigation';
import { agentOptions } from '../../../features/auth/acting-identity.ts';
import { AgentPicker, type AgentPickerNotice } from '../../../features/auth/agent-picker.tsx';
import { safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { readSession, sessionAgentState, sessionDiscovery } from '../../../features/auth/session.ts';
import { PageContainer } from '../../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../../i18n/server.ts';
import { localizedPath } from '../../../i18n/locale.ts';

const reported = new Set(['invalid', 'stale-session', 'stale-default',
  'default-not-saved', 'unavailable'] as const);

export default async function IdentityPage({ searchParams }: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  const locale = await requestLocale();
  const next = safeReturnPath(query.next, localizedPath('/', locale));
  const session = await readSession();
  if (!session) redirect(signInPath(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(next)}`));
  const [discovery, state] = await Promise.all([sessionDiscovery(), sessionAgentState()]);
  const error = [...reported].find(kind => kind === query.error);
  const notice: AgentPickerNotice | null = error ? { kind: error }
    : session.agent.status === 'ineligible' ? { kind: 'ineligible', previous: session.agent.previous }
      : state?.mainAgent.actingSubject && !state.mainAgent.eligible
        ? { kind: 'ineligible-default', previous: state.mainAgent.actingSubject }
        : discovery && state ? null : { kind: 'unavailable' };
  return <PageContainer className="max-w-xl sm:py-12"><Card><CardContent>
    <AgentPicker options={discovery && state ? agentOptions(discovery) : null}
      current={session.agent.status === 'selected' ? session.agent.agent.iri : null}
      preferred={state?.mainAgent.eligible ? state.mainAgent.actingSubject : null}
      preferenceRevision={state?.mainAgent.revision ?? null}
      sessionRevision={state?.sessionAgent.revision ?? null}
      next={next} locale={locale} notice={notice} messages={await getMessages('auth', locale)} />
  </CardContent></Card></PageContainer>;
}
