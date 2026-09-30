import { EntityNotFound } from '../../../../features/entity-page/entity-page.tsx';
import { copyOf } from '../../../../features/entity-page/messages.ts';
import { requestLocale } from '../../../../i18n/server.ts';

export default async function EntityNotFoundPage() {
  return <EntityNotFound t={copyOf(await requestLocale())} />;
}
