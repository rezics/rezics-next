import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('Œuvre {{id}}', { id: String }),
  fallbackTitle: 'Titre affiché dans une autre langue',
  ratingCount: plural({ one: insert('{{count}} note'), other: insert('{{count}} notes') },
    { count: asValue(number()) }),
  averageRating: insert('Note moyenne : {{mean}} sur {{max}} ({{count}})', { mean: String, max: String, count: String }),
  ownRating: insert('Votre note : {{value}} sur {{max}}', { value: String, max: String }),
  yourRating: 'Votre note',
  noRatings: 'Aucune note pour le moment',
  previous: 'Précédent', next: 'Suivant', seeAll: 'Tout voir',
  wantToRead: 'À lire', reading: 'En cours de lecture', read: 'Lu',
  removeFromShelf: 'Retirer de mes étagères',
  shelve: insert('Ajouter « {{title}} » à une étagère', { title: String }),
  shelfOptions: 'Autres étagères',
  signInToShelve: 'Connectez-vous pour garder une liste de lecture',
  rateThis: 'Noter cette œuvre',
  signInToRate: 'Connectez-vous pour noter cette œuvre',
  saving: 'Enregistrement…',
  saveFailed: 'Enregistrement impossible. Réessayez.',
  ongoing: 'En cours', hiatus: 'En pause',
  whyItsHere: 'Pourquoi cette œuvre est ici', openRecipe: 'Ouvrir la recette', install: 'Installer', copyPrompt: 'Copier le prompt',
  promptCopied: 'Prompt copié', copyFailed: 'Copie impossible. Réessayez.',
  typeBook: 'Livre', typeGuide: 'Guide', typeRecipe: 'Recette', typePrompt: 'Prompt', typeSkill: 'Compétence', typeMod: 'Mod',
  typeSoftware: 'Logiciel', typeFilm: 'Film', typeSeries: 'Série télévisée', typeVideo: 'Vidéo', typeAudio: 'Audio', typeMusic: 'Musique',
} satisfies Partial<CatalogueMessages>;
