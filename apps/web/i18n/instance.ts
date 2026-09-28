import { create } from 'native-i18n';
import { resources } from './resources.ts';

/** The translator over every feature catalog. Server code reads it through
 * server.ts; client code gets materialized messages as props, so importing
 * locale.ts path helpers never pulls the catalogs into the browser bundle. */
export const i18n = create(resources);
