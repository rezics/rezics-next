import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { DownloadData } from '../../../../features/account/download-data.tsx';

export default async function DownloadDataPage() {
  return renderAccountPage('data-privacy', () => <DownloadData />, '/data-privacy/download');
}
