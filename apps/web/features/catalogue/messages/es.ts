import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('Obra {{id}}', { id: String }),
  fallbackTitle: 'Título en otro idioma',
  ratingCount: plural({ one: insert('{{count}} valoración'), other: insert('{{count}} valoraciones') },
    { count: asValue(number()) }),
  averageRating: insert('Valoración media: {{mean}} de {{max}} ({{count}})', { mean: String, max: String, count: String }),
  ownRating: insert('Tu valoración: {{value}} de {{max}}', { value: String, max: String }),
  yourRating: 'Tu valoración',
  noRatings: 'Todavía no hay valoraciones',
  previous: 'Anterior', next: 'Siguiente', seeAll: 'Ver todo',
  wantToRead: 'Quiero leer', reading: 'Leyendo', read: 'Leído',
  removeFromShelf: 'Quitar de mis estanterías',
  shelve: insert('Añadir «{{title}}» a una estantería', { title: String }),
  shelfOptions: 'Más estanterías',
  signInToShelve: 'Inicia sesión para guardar tu lista de lectura',
  rateThis: 'Valorar esta obra',
  signInToRate: 'Inicia sesión para valorar esta obra',
  saving: 'Guardando…',
  saveFailed: 'No se pudo guardar. Inténtalo de nuevo.',
  ongoing: 'En curso', hiatus: 'En pausa',
  whyItsHere: 'Por qué aparece aquí', openRecipe: 'Abrir receta', install: 'Instalar', copyPrompt: 'Copiar prompt',
  promptCopied: 'Prompt copiado', copyFailed: 'No se pudo copiar. Inténtalo de nuevo.',
} satisfies Partial<CatalogueMessages>;
