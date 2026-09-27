import { RealmNotFound } from '../../../../features/realm/states.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

export default async function RealmNotFoundPage() {
  return <RealmNotFound messages={await getMessages('realm', await requestLocale())} />;
}
