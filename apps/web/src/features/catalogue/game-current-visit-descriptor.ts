export type GameClassificationLocator = {
  holder: string;
  property: string;
  statement: string;
};

export type GameClassificationReturn = GameClassificationLocator & {
  source: string;
  context: string;
  realm?: string;
  type: string;
  locale: string;
  release: string;
  reader: string | null;
  focus: 'keyboard' | 'none';
};

export const gameClassificationReturnPrefix = '#game-classification-return?';
export const gameClassificationReturnLimit = 2048;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const propertyId = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]{1,128}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const locales = new Set(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es']);

function bounded(value: string): boolean {
  return (
    value.length <= gameClassificationReturnLimit &&
    new TextEncoder().encode(value).byteLength <= gameClassificationReturnLimit &&
    encodeURIComponent(value).length <= gameClassificationReturnLimit
  );
}

/** One exact current occurrence and focus intent. It carries no evidence, reveal or command state. */
export function gameClassificationReturn(fragment: string): GameClassificationReturn | undefined {
  if (!fragment.startsWith(gameClassificationReturnPrefix) || !bounded(fragment)) return;
  const params = new URLSearchParams(fragment.slice(gameClassificationReturnPrefix.length));
  const keys = [...params.keys()];
  const allowed = [
    'source',
    'holder',
    'context',
    'realm',
    'type',
    'locale',
    'release',
    'reader',
    'property',
    'statement',
    'focus',
  ];
  if (
    keys.length < allowed.length - 1 ||
    keys.length > allowed.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !allowed.includes(key))
  )
    return;
  const source = params.get('source');
  const holder = params.get('holder');
  const context = params.get('context');
  const realm = params.get('realm');
  const type = params.get('type');
  const locale = params.get('locale');
  const release = params.get('release');
  const reader = params.get('reader');
  const property = params.get('property');
  const statement = params.get('statement');
  const focus = params.get('focus');
  if (
    !source ||
    source.length > 1024 ||
    !source.startsWith('/') ||
    source.startsWith('//') ||
    !holder ||
    !uuid.test(holder) ||
    !context ||
    !uuid.test(context) ||
    (realm !== null && !uuid.test(realm)) ||
    !type ||
    !propertyId.test(type) ||
    !locale ||
    !locales.has(locale) ||
    !release ||
    !digest.test(release) ||
    !reader ||
    (reader !== 'anonymous' && !uuid.test(reader)) ||
    !property ||
    !propertyId.test(property) ||
    !statement ||
    !uuid.test(statement) ||
    (focus !== 'keyboard' && focus !== 'none')
  )
    return;
  let address: URL;
  try {
    address = new URL(source, 'https://rezics.invalid');
  } catch {
    return;
  }
  const path = address.pathname.split('/');
  const searchKeys = [...address.searchParams.keys()];
  if (
    address.origin !== 'https://rezics.invalid' ||
    address.hash ||
    path[1] !== locale ||
    path[2] !== 'subjects' ||
    path[3]?.toLowerCase() !== holder.toLowerCase() ||
    !path[4] ||
    path[5] !== undefined ||
    new Set(searchKeys).size !== searchKeys.length ||
    searchKeys.some((key) => key !== 'realm') ||
    address.searchParams.get('realm') !== realm
  )
    return;
  return {
    source,
    holder,
    context,
    ...(realm ? { realm } : {}),
    type,
    locale,
    release,
    reader: reader === 'anonymous' ? null : reader,
    property,
    statement,
    focus,
  };
}

export function gameClassificationReturnFragment(value: GameClassificationReturn): string | undefined {
  const params = new URLSearchParams({
    source: value.source,
    holder: value.holder,
    context: value.context,
    ...(value.realm ? { realm: value.realm } : {}),
    type: value.type,
    locale: value.locale,
    release: value.release,
    reader: value.reader ?? 'anonymous',
    property: value.property,
    statement: value.statement,
    focus: value.focus,
  });
  const fragment = `${gameClassificationReturnPrefix}${params}`;
  const parsed = gameClassificationReturn(fragment);
  return parsed && bounded(fragment) ? fragment : undefined;
}

export const gameClassificationReturnStorageKey = 'rezics:game-classification-return:v1';

/** A same-tab, one-use marker prevents a copied URL or new tab from reviving pending focus. */
export function consumeGameClassificationReturn(storage: Pick<Storage, 'getItem' | 'removeItem'>, address: string) {
  const recorded = storage.getItem(gameClassificationReturnStorageKey);
  storage.removeItem(gameClassificationReturnStorageKey);
  return recorded === address;
}
