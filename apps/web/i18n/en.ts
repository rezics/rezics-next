export const shell = {
  home: 'REZICS home', searchPlaceholder: 'Search works…', searchLabel: 'Search works',
  search: 'Search', navigation: 'Main navigation', studio: 'Studio', identity: 'Identity',
  signIn: 'Sign in', language: 'Interface language', english: 'English', chinese: '简体中文',
};

export const home = {
  title: 'Find a work. Follow its meaning.',
  description: 'Search published works and view each result in its selected context.',
  explore: 'Explore works →',
};

export const search = {
  title: 'Search works', emptyPhrase: 'Enter a search above', perspectiveLabel: 'View results from a perspective',
  globalPerspective: 'Global perspective', realmPerspective: 'Realm perspective', realmId: 'Realm ID',
  perspectiveHelp: 'The perspective sets the context for how works are selected.',
  filters: 'Search filters', language: 'Language', anyLanguage: 'Any language',
  english: 'English', spanish: 'Spanish', japanese: 'Japanese',
  languageHelp: 'Searches published contribution text in the selected language.',
  filterResults: 'Filter results', invalidRealm: 'Enter a full Realm ID to search this perspective.',
  resultsRegion: 'Search results', results: 'Results', resultsPrefix: 'Showing ', resultsSuffix: ' results',
  sequencePrefix: 'Complete at sequence ', idle: 'Enter at least two characters to search.',
  loading: 'Searching…', errorPrefix: 'Search is unavailable: ', retry: 'try again shortly',
  empty: 'No works matched this search.', workPrefix: 'Work ', mainVersion: 'Main Version',
  revision: 'Revision', workId: 'Work ID:', realmRelation: 'Realm relation', textMatch: 'Text match',
  defaultReason: 'Matched the phrase in a published contribution.',
};

export const auth = {
  chooseIdentity: 'Choose an acting identity',
  identityHelp: 'Enter an identity you are authorized to use. The service checks your authority for each action.',
  identityId: 'Identity ID', invalidIdentity: 'Enter a full REZICS identity ID.', continue: 'Continue',
  createAccountHeading: 'Create your REZICS account', signInHeading: 'Sign in to REZICS',
  accountHelp: 'Use your account to work with versions and contributions.',
  nameLabel: 'Name', email: 'Email', password: 'Password', accountFailed: 'Account sign-in failed',
  connecting: 'Connecting…', createAccount: 'Create account', signIn: 'Sign in',
  newHere: 'New to REZICS?', alreadyHaveAccount: 'Already have an account?',
  createAccountLink: 'Create an account',
};

export const work = {
  unavailable: 'This revision is unavailable. Your access or the source service may have changed.',
  exactRevision: 'Exact revision', perspective: 'Perspective', globalPerspective: 'Global perspective',
  perspectiveHelp: 'This exact revision follows the Main Version record.',
  mainVersion: 'Main Version', selectedVersion: 'Selected version',
  metadataPrefix: 'This exact metadata revision is retained as ',
  metadataSuffix: '.',
  revisionDetails: 'Revision details', work: 'Work', operation: 'Operation',
  language: 'Language', sequence: 'Sequence',
};

export const studio = {
  createHeading: 'Create a Work',
  createHelp: 'Start with a title. Contributions and Realm decisions can be added after creation.',
  workTitle: 'Work title', creating: 'Creating…', createWork: 'Create Work',
  createdStatus: 'Work created', createdHeading: 'Work created.',
  createdSuffix: ' and its Main Version were saved. Keep these IDs for later edits.',
  work: 'Work', mainVersion: 'Main Version', revision: 'Revision', sourceSequence: 'Source sequence',
  titleError: 'Enter a title of at most 200 characters.',
  denied: 'This identity is not authorized to create a Work.',
  unavailable: 'Work creation is unavailable.', noResult: 'Work creation returned no result.',
  pending: 'The Work is still being reconciled. Keep your title and try again shortly.',
};
