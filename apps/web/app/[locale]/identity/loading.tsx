import { Card, CardContent } from '@rezics/ui/card';
import { AgentPickerLoading } from '../../../features/auth/agent-picker-loading.tsx';
import { PageContainer } from '../../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../../i18n/server.ts';

export default async function IdentityLoading() {
  const locale = await requestLocale();
  const [auth, work] = await Promise.all([getMessages('auth', locale), getMessages('workPage', locale)]);
  return <PageContainer className="max-w-xl sm:py-12"><Card><CardContent>
    <AgentPickerLoading heading={auth.chooseAgentHeading} label={work.loadingRegion} />
  </CardContent></Card></PageContainer>;
}
