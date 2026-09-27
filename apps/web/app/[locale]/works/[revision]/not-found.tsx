import { WorkNotFound } from '../../../../features/work/work-states.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

export default async function RevisionNotFound() {
  const messages = await getMessages('work', await requestLocale());
  return <WorkNotFound messages={messages} />;
}
