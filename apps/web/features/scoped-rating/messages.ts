import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Rating something in a place (an episode, a match, a continuity): choosing the place, the questions asked of it, the
// figures per place and the continuity switch. No model word reaches a reader: Main's "projection", "frame" and
// "context" are "part", "place" and "question" here.
const en = {
  // Choosing where
  trigger: 'Rate in a specific part',
  sheetTitle: insert('Rate {{name}} in a specific part', { name: String }),
  sheetBody: 'Choose where this rating applies: an episode, chapter, route, match, map, continuity or game version. '
    + 'Ratings for one place never mix with another’s.',
  places: 'Where',
  dimensionPosition: 'Episode or chapter',
  dimensionEvent: 'Match or event',
  dimensionContinuity: 'Continuity',
  dimensionWork: 'Work',
  dimensionRelease: 'Release',
  dimensionRealization: 'Edition',
  searchPlaces: 'Search',
  chosen: 'Chosen',
  nothingChosen: 'Choose at least one to continue.',
  removePlace: insert('Remove {{name}}', { name: String }),
  continue: 'Continue',
  chooseDifferently: 'Choose differently',
  retry: 'Try again',

  // Why something has no data
  failMissing: 'This isn’t visible here, or it no longer exists.',
  failSignIn: 'Sign in to rate.',
  failDenied: 'You can’t rate this here.',
  failInvalid: 'These can’t be combined. Choose one place of each kind.',
  failUnavailable: 'This could not be loaded right now. Try again in a moment.',
  failConflict: 'This changed somewhere else. Reload to see the latest.',

  // The questions asked of a place
  questions: 'Questions',
  noQuestions: 'No question applies here yet, so it can’t be rated.',
  signInToRate: 'Sign in to rate',
  yourRating: 'Your rating',
  yourRatingValue: insert('Your rating: {{value}}/{{max}}', { value: String, max: String }),
  removeRating: 'Remove my rating',
  saving: 'Saving…',
  saved: 'Saved',
  savedPending: 'Saved. It will show up shortly.',
  saveFailed: 'Your rating could not be saved. Try again.',
  saveConflict: 'Your rating was changed somewhere else, so this one wasn’t saved.',
  writeReview: 'Write a review',
  discuss: 'Discuss',

  // Figures
  noRatings: 'No ratings yet',
  score: insert('{{mean}}/{{max}}', { mean: String, max: String }),
  scoreSpoken: insert('{{mean}} out of {{max}}', { mean: String, max: String }),
  ratingCount: plural({ one: insert('{{count}} rating'), other: insert('{{count}} ratings') }, { count: asValue(number()) }),
  moreToReveal: plural({ one: insert('{{count}} more rating will reveal the average'),
    other: insert('{{count}} more ratings will reveal the average') }, { count: asValue(number()) }),
  moreToRevealUnknown: 'The average appears once enough people have rated.',
  histogram: 'Ratings by score',
  barCount: insert('{{count}} ({{share}})', { count: String, share: String }),

  // The header of a rated place
  within: 'In',
  hidden: 'Hidden until you reach it',
  hiddenHelp: 'This comes later than the place you have read up to, so its name and ratings stay hidden.',

  // One subject, place by place
  byPart: 'Ratings by part',
  noParts: 'Nobody has rated this in a specific part yet.',
  hiddenParts: plural({ one: insert('{{count}} more is hidden until you reach it.'),
    other: insert('{{count}} more are hidden until you reach them.') }, { count: asValue(number()) }),
  showMore: 'Show more',
  loading: 'Loading…',
  moreQuestions: plural({ one: insert('and {{count}} more question'), other: insert('and {{count}} more questions') },
    { count: asValue(number()) }),

  // Combined figures
  unitEpisodes: 'episodes',
  unitChapters: 'chapters',
  unitMatches: 'matches',
  unitMaps: 'maps',
  unitParts: 'parts',
  combined: insert('All {{unit}} together', { unit: String }),
  combineAs: 'Combined as',
  formulaPooled: 'Pooled',
  formulaMeanOfMeans: insert('Average of {{unit}}', { unit: String }),
  explainPooled: 'Pooled: every rating counts the same, so a part with more ratings weighs more.',
  explainMeanOfMeans: insert('Average of {{unit}}: every one counts the same, however many ratings it has.', { unit: String }),
  coverage: insert('{{met}} of {{total}} {{unit}} have enough ratings to count.', { met: String, total: String, unit: String }),
  combinedWithheld: insert('No combined score yet: fewer than half of the {{unit}} have enough ratings.', { unit: String }),
  combinedNone: 'Nothing here has been rated yet.',
  notCounted: plural({ one: insert('{{count}} was left out because this question doesn’t apply to it.'),
    other: insert('{{count}} were left out because this question doesn’t apply to them.') }, { count: asValue(number()) }),
  unreadable: plural({ one: insert('{{count}} could not be read.'), other: insert('{{count}} could not be read.') },
    { count: asValue(number()) }),

  // Ranking of an event's participants
  ranking: 'Ranking',
  rankingBasis: 'Ranked by weighted rating. A score is pulled toward the overall average until many people have rated, '
    + 'so a few high ratings can’t outrank a well-tested record.',
  rankingEligibility: insert('Needs at least {{min}} ratings to be ranked.', { min: String }),
  rankingPrior: insert('Overall average {{mean}} from {{ratings}}.', { mean: String, ratings: String }),
  rankingPlace: insert('Rank {{position}}', { position: String }),
  rankingWeighted: insert('Weighted {{score}}', { score: String }),
  rankingNone: 'No one has enough ratings to be ranked yet.',
  rankingWaiting: 'Not ranked yet',
  rankingProgress: insert('{{count}} of {{min}} ratings', { count: String, min: String }),
  rankingUnavailable: 'The ranking isn’t available right now.',

  // The continuity switch
  continuity: 'Continuity',
  continuityAll: 'All continuities',
  continuityTitle: 'Read in a continuity',
  continuityBody: 'Choose the continuity these pages are read in. They show what holds there and keep your choice as you move around.',
  continuityAllNote: 'Show everything, with the continuities each fact belongs to.',
  continuityStory: 'Story continuities',
  continuityWork: 'Works',
  continuityNow: insert('Showing {{name}}', { name: String }),
  continuityClear: 'Show all continuities',
};

export const englishMessages = en;
export type ScopedRatingMessages = typeof en;

export const messages = defineMessages({
  en,
  'zh-Hant': withEnglish(en, zhHant),
  'zh-Hans': withEnglish(en, zhHans),
  ja: withEnglish(en, ja),
  ko: withEnglish(en, ko),
  de: withEnglish(en, de),
  fr: withEnglish(en, fr),
  es: withEnglish(en, es),
});
