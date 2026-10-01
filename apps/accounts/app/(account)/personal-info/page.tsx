import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { PersonalInfo } from '../../../features/account/personal-info.tsx';
import { readContentPreferences, readDisplayPreferences } from '../../../features/api/server.ts';

export default async function PersonalInfoPage() {
  return renderAccountPage('personal-info', async ({ session }) => {
    const [preferences, contentPreferences] = await Promise.all([readDisplayPreferences(), readContentPreferences()]);
    return <PersonalInfo user={session.user} preferences={preferences} contentPreferences={contentPreferences} />;
  });
}
