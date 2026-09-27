import { WorkNotFound } from '../../../../features/work-page/work-states.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

export default async function WorkNotFoundPage() {
  return <WorkNotFound messages={await getMessages('workPage', await requestLocale())} />;
}
