import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { PersonalInfo } from '../../../features/account/personal-info.tsx';
import { readDisplayPreferences } from '../../../features/api/server.ts';

export default async function PersonalInfoPage() {
  return renderAccountPage('personal-info', async ({ session }) =>
    <PersonalInfo user={session.user} preferences={await readDisplayPreferences()} />);
}
