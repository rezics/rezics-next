import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { PersonalInfo } from '../../../features/account/personal-info.tsx';

export default async function PersonalInfoPage() {
  return renderAccountPage('personal-info', ({ session }) => <PersonalInfo user={session.user} />);
}
