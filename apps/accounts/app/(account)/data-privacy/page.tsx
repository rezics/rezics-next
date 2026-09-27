import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { DataPrivacy } from '../../../features/account/data-privacy.tsx';

export default async function DataPrivacyPage() {
  return renderAccountPage('data-privacy', () => <DataPrivacy />);
}
