import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('Werk {{id}}', { id: String }),
  fallbackTitle: 'Titel in einer anderen Sprache',
  ratingCount: plural({ one: insert('{{count}} Bewertung'), other: insert('{{count}} Bewertungen') },
    { count: asValue(number()) }),
  averageRating: insert('Durchschnittsbewertung: {{mean}} von {{max}}, {{count}}', { mean: String, max: String, count: String }),
  ownRating: insert('Deine Bewertung: {{value}} von {{max}}', { value: String, max: String }),
  yourRating: 'Deine Bewertung',
  noRatings: 'Noch keine Bewertungen',
  previous: 'Zurück', next: 'Weiter', seeAll: 'Alle anzeigen',
  wantToRead: 'Möchte ich lesen', reading: 'Lese ich gerade', read: 'Gelesen',
  removeFromShelf: 'Aus meinen Regalen entfernen',
  shelve: insert('„{{title}}“ ins Regal stellen', { title: String }),
  shelfOptions: 'Weitere Regale',
  signInToShelve: 'Melde dich an, um eine Leseliste zu führen',
  rateThis: 'Dieses Werk bewerten',
  signInToRate: 'Melde dich an, um dieses Werk zu bewerten',
  saving: 'Wird gespeichert…',
  saveFailed: 'Speichern fehlgeschlagen. Bitte versuche es erneut.',
  ongoing: 'Laufend', hiatus: 'Pausiert',
  whyItsHere: 'Warum es hier steht', openRecipe: 'Rezept öffnen', install: 'Installieren', copyPrompt: 'Prompt kopieren',
  promptCopied: 'Prompt kopiert', copyFailed: 'Kopieren fehlgeschlagen. Bitte versuche es erneut.',
  typeBook: 'Buch', typeGuide: 'Anleitung', typeRecipe: 'Rezept', typePrompt: 'Prompt', typeSkill: 'Skill', typeMod: 'Mod',
  typeSoftware: 'Software', typeFilm: 'Film', typeSeries: 'Fernsehserie', typeVideo: 'Video', typeAudio: 'Audio', typeMusic: 'Musik',
} satisfies Partial<CatalogueMessages>;
