/** Strict decoder for the additive account preference-page envelope. */

export const PREFERENCE_READING_DEFAULTS = Object.freeze({ spoilerLevel: 0, suitability: 'blur' } as const);
export const PREFERENCE_SHELF_LAYOUTS = ['grid', 'list', 'table'] as const;
export const PREFERENCE_SHELF_TABS = ['in_progress', 'planned', 'completed', 'paused', 'dropped', 'all'] as const;
export const PREFERENCE_SHELF_SORT_FIELDS = [
  'last_activity',
  'added',
  'finished',
  'title',
  'rating',
  'release_date',
  'progress',
] as const;
export const PREFERENCE_SHELF_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const PREFERENCE_SHELF_GRID_SIZES = ['small', 'medium', 'large'] as const;
export const PREFERENCE_SHELF_TABLE_COLUMNS = [
  'cover',
  'title',
  'creator',
  'type',
  'status',
  'progress',
  'rating',
  'added',
  'started',
  'finished',
  'last_activity',
] as const;
export const PREFERENCE_SHELF_LIMITS = Object.freeze({
  maxLayouts: 32,
  scopeMaxLength: 256,
  scopePattern: '^(?:all|[A-Za-z][A-Za-z0-9+.-]*:\\S+)$',
} as const);
export type PreferenceSpoilerLevel = 0 | 1 | 2;
export type PreferenceSuitability = 'blur' | 'show';
export type PreferenceShelfLayout = (typeof PREFERENCE_SHELF_LAYOUTS)[number];
export type PreferenceShelfTab = (typeof PREFERENCE_SHELF_TABS)[number];
export type PreferenceShelfSortField = (typeof PREFERENCE_SHELF_SORT_FIELDS)[number];
export type PreferenceShelfSortDirection = (typeof PREFERENCE_SHELF_SORT_DIRECTIONS)[number];
export type PreferenceShelfGridSize = (typeof PREFERENCE_SHELF_GRID_SIZES)[number];
export type PreferenceShelfColumn = (typeof PREFERENCE_SHELF_TABLE_COLUMNS)[number];
export type PreferenceShelfStored = {
  layouts?: Partial<Record<string, PreferenceShelfLayout>>;
  sorts?: Partial<Record<PreferenceShelfTab, { field: PreferenceShelfSortField; direction: PreferenceShelfSortDirection }>>;
  gridSize?: PreferenceShelfGridSize;
  tableColumns?: PreferenceShelfColumn[];
};
export type PreferenceActionAdvice =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'not_authorized' };
export type PreferenceShelfAdvice = {
  supported: {
    layouts: PreferenceShelfLayout[];
    tabs: PreferenceShelfTab[];
    sortFields: PreferenceShelfSortField[];
    sortDirections: PreferenceShelfSortDirection[];
    gridSizes: PreferenceShelfGridSize[];
    tableColumns: PreferenceShelfColumn[];
  };
  limits: {
    maxLayouts: typeof PREFERENCE_SHELF_LIMITS.maxLayouts;
    scopeMaxLength: typeof PREFERENCE_SHELF_LIMITS.scopeMaxLength;
    scopePattern: typeof PREFERENCE_SHELF_LIMITS.scopePattern;
  };
  effective: PreferenceShelfStored;
  defaults: PreferenceShelfStored;
};
export type PreferencePageAdvice = {
  viewerState: 'current';
  allowedActions: { read: PreferenceActionAdvice; update: PreferenceActionAdvice };
  reading: {
    supported: { spoilerLevels: PreferenceSpoilerLevel[]; suitability: PreferenceSuitability[] };
    effective: { spoilerLevel: PreferenceSpoilerLevel; suitability: PreferenceSuitability };
    defaults: { spoilerLevel: 0; suitability: 'blur' };
  };
  shelfAdvice?: PreferenceShelfAdvice;
};
export type PreferencePageValues = {
  spoilerLevel: PreferenceSpoilerLevel;
  suitability: PreferenceSuitability;
  version: number;
  shelf?: unknown;
  notifications?: unknown;
};
export type PreferenceReadingPage = PreferencePageValues & PreferencePageAdvice;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spoilerLevel(value: unknown): PreferenceSpoilerLevel | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}

function suitability(value: unknown): PreferenceSuitability | undefined {
  return value === 'blur' || value === 'show' ? value : undefined;
}

function uniqueMembers<T>(values: T[], allowed: (value: unknown) => value is T): T[] | undefined {
  if (new Set(values).size !== values.length) return undefined;
  const members: T[] = [];
  for (const value of values) {
    if (!allowed(value)) return undefined;
    members.push(value);
  }
  return members;
}

function actionAdvice(value: unknown): PreferenceActionAdvice | undefined {
  if (!isRecord(value) || value.allowed === true) {
    return isRecord(value) && value.allowed === true && Object.keys(value).length === 1 ? { allowed: true } : undefined;
  }
  return value.allowed === false && value.reason === 'not_authorized' && Object.keys(value).length === 2
    ? { allowed: false, reason: 'not_authorized' }
    : undefined;
}

/** Confirmed stored values, or `undefined` when spoiler, suitability or version cannot be read. */
export function decodePreferenceValues(value: unknown): PreferencePageValues | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 0) return undefined;
  const spoiler = spoilerLevel(value.spoilerLevel);
  const image = suitability(value.suitability);
  if (spoiler === undefined || image === undefined) return undefined;
  return {
    spoilerLevel: spoiler,
    suitability: image,
    version: value.version as number,
    ...(value.shelf !== undefined ? { shelf: value.shelf } : {}),
    ...(value.notifications !== undefined ? { notifications: value.notifications } : {}),
  };
}

const shelfScope = new RegExp(PREFERENCE_SHELF_LIMITS.scopePattern);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function catalogue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length) return undefined;
  return uniqueMembers(value, (entry): entry is T => (allowed as readonly unknown[]).includes(entry));
}

function storedShelf(value: unknown): PreferenceShelfStored | undefined {
  if (!isRecord(value) || !onlyKeys(value, ['layouts', 'sorts', 'gridSize', 'tableColumns'])) return undefined;
  const stored: PreferenceShelfStored = {};
  if (value.layouts !== undefined) {
    if (
      !isRecord(value.layouts) ||
      Object.keys(value.layouts).length > PREFERENCE_SHELF_LIMITS.maxLayouts ||
      Object.entries(value.layouts).some(
        ([scope, layout]) =>
          scope.length > PREFERENCE_SHELF_LIMITS.scopeMaxLength ||
          !shelfScope.test(scope) ||
          !(PREFERENCE_SHELF_LAYOUTS as readonly string[]).includes(String(layout)),
      )
    )
      return undefined;
    stored.layouts = { ...(value.layouts as NonNullable<PreferenceShelfStored['layouts']>) };
  }
  if (value.sorts !== undefined) {
    if (!isRecord(value.sorts) || Object.keys(value.sorts).some((tab) => !(PREFERENCE_SHELF_TABS as readonly string[]).includes(tab)))
      return undefined;
    const sorts: NonNullable<PreferenceShelfStored['sorts']> = {};
    for (const [tab, entry] of Object.entries(value.sorts)) {
      if (
        !isRecord(entry) ||
        !onlyKeys(entry, ['field', 'direction']) ||
        !(PREFERENCE_SHELF_SORT_FIELDS as readonly string[]).includes(String(entry.field)) ||
        !(PREFERENCE_SHELF_SORT_DIRECTIONS as readonly string[]).includes(String(entry.direction))
      )
        return undefined;
      sorts[tab as PreferenceShelfTab] = {
        field: entry.field as PreferenceShelfSortField,
        direction: entry.direction as PreferenceShelfSortDirection,
      };
    }
    stored.sorts = sorts;
  }
  if (value.gridSize !== undefined) {
    if (!(PREFERENCE_SHELF_GRID_SIZES as readonly string[]).includes(String(value.gridSize))) return undefined;
    stored.gridSize = value.gridSize as PreferenceShelfGridSize;
  }
  if (value.tableColumns !== undefined) {
    if (
      !Array.isArray(value.tableColumns) ||
      value.tableColumns.length < 1 ||
      value.tableColumns.length > PREFERENCE_SHELF_TABLE_COLUMNS.length ||
      new Set(value.tableColumns).size !== value.tableColumns.length ||
      value.tableColumns.some((column) => !(PREFERENCE_SHELF_TABLE_COLUMNS as readonly string[]).includes(String(column)))
    )
      return undefined;
    stored.tableColumns = [...(value.tableColumns as PreferenceShelfColumn[])];
  }
  return stored;
}

function sameStoredShelf(a: PreferenceShelfStored, b: unknown): boolean {
  const other = storedShelf(b);
  return !!other && JSON.stringify(a) === JSON.stringify(other);
}

/** Native shelf observation, or `undefined` when catalogues, limits, defaults or stored values are unreadable. */
export function decodePreferenceShelfAdvice(value: unknown): PreferenceShelfAdvice | undefined {
  if (!isRecord(value) || !isRecord(value.shelfAdvice)) return undefined;
  const advice = value.shelfAdvice;
  if (
    !isRecord(advice.supported) ||
    !isRecord(advice.limits) ||
    !isRecord(advice.effective) ||
    !isRecord(advice.defaults) ||
    Object.keys(advice).some((key) => key !== 'supported' && key !== 'limits' && key !== 'effective' && key !== 'defaults')
  )
    return undefined;
  const { supported, limits } = advice;
  if (
    Object.keys(supported).some(
      (key) =>
        key !== 'layouts' &&
        key !== 'tabs' &&
        key !== 'sortFields' &&
        key !== 'sortDirections' &&
        key !== 'gridSizes' &&
        key !== 'tableColumns',
    ) ||
    Object.keys(limits).some((key) => key !== 'maxLayouts' && key !== 'scopeMaxLength' && key !== 'scopePattern')
  )
    return undefined;
  const layouts = catalogue(supported.layouts, PREFERENCE_SHELF_LAYOUTS);
  const tabs = catalogue(supported.tabs, PREFERENCE_SHELF_TABS);
  const sortFields = catalogue(supported.sortFields, PREFERENCE_SHELF_SORT_FIELDS);
  const sortDirections = catalogue(supported.sortDirections, PREFERENCE_SHELF_SORT_DIRECTIONS);
  const gridSizes = catalogue(supported.gridSizes, PREFERENCE_SHELF_GRID_SIZES);
  const tableColumns = catalogue(supported.tableColumns, PREFERENCE_SHELF_TABLE_COLUMNS);
  if (!layouts || !tabs || !sortFields || !sortDirections || !gridSizes || !tableColumns) return undefined;
  if (
    limits.maxLayouts !== PREFERENCE_SHELF_LIMITS.maxLayouts ||
    limits.scopeMaxLength !== PREFERENCE_SHELF_LIMITS.scopeMaxLength ||
    limits.scopePattern !== PREFERENCE_SHELF_LIMITS.scopePattern
  )
    return undefined;
  if (Object.keys(advice.defaults).length !== 0) return undefined;
  const effective = storedShelf(advice.effective);
  if (!effective) return undefined;
  return {
    supported: { layouts, tabs, sortFields, sortDirections, gridSizes, tableColumns },
    limits: { ...PREFERENCE_SHELF_LIMITS },
    effective,
    defaults: {},
  };
}

/** Owner reading advice, or `undefined` when any choice or action field is missing or malformed. */
export function decodePreferenceAdvice(value: unknown): PreferencePageAdvice | undefined {
  if (
    !isRecord(value) ||
    value.viewerState !== 'current' ||
    !isRecord(value.allowedActions) ||
    !isRecord(value.reading)
  )
    return undefined;
  const read = actionAdvice(value.allowedActions.read);
  const update = actionAdvice(value.allowedActions.update);
  if (!read || !update || Object.keys(value.allowedActions).some((key) => key !== 'read' && key !== 'update'))
    return undefined;
  const { supported, effective, defaults } = value.reading;
  if (
    !isRecord(supported) ||
    !isRecord(effective) ||
    !isRecord(defaults) ||
    Object.keys(value.reading).some((key) => key !== 'supported' && key !== 'effective' && key !== 'defaults')
  )
    return undefined;
  if (
    !Array.isArray(supported.spoilerLevels) ||
    !Array.isArray(supported.suitability) ||
    Object.keys(supported).some((key) => key !== 'spoilerLevels' && key !== 'suitability')
  )
    return undefined;
  const spoilerLevels = uniqueMembers(supported.spoilerLevels, (entry): entry is PreferenceSpoilerLevel =>
    [0, 1, 2].includes(entry as number),
  );
  const suitabilityChoices = uniqueMembers(
    supported.suitability,
    (entry): entry is PreferenceSuitability => entry === 'blur' || entry === 'show',
  );
  if (
    !spoilerLevels ||
    !suitabilityChoices ||
    spoilerLevels.length < 1 ||
    spoilerLevels.length > 3 ||
    suitabilityChoices.length < 1 ||
    suitabilityChoices.length > 2
  )
    return undefined;
  const effectiveSpoiler = spoilerLevel(effective.spoilerLevel);
  const effectiveSuitability = suitability(effective.suitability);
  if (
    effectiveSpoiler === undefined ||
    effectiveSuitability === undefined ||
    !spoilerLevels.includes(effectiveSpoiler) ||
    !suitabilityChoices.includes(effectiveSuitability) ||
    Object.keys(effective).some((key) => key !== 'spoilerLevel' && key !== 'suitability')
  )
    return undefined;
  if (
    defaults.spoilerLevel !== 0 ||
    defaults.suitability !== 'blur' ||
    Object.keys(defaults).some((key) => key !== 'spoilerLevel' && key !== 'suitability')
  )
    return undefined;
  const reading: PreferencePageAdvice = {
    viewerState: 'current',
    allowedActions: { read, update },
    reading: {
      supported: { spoilerLevels, suitability: suitabilityChoices },
      effective: { spoilerLevel: effectiveSpoiler, suitability: effectiveSuitability },
      defaults: { spoilerLevel: 0, suitability: 'blur' },
    },
  };
  const shelfAdvice = decodePreferenceShelfAdvice(value);
  if (!shelfAdvice) return reading;
  const stored = value.shelf === undefined ? {} : storedShelf(value.shelf);
  if (!stored || !sameStoredShelf(shelfAdvice.effective, stored)) return reading;
  return { ...reading, shelfAdvice };
}

/** Complete native page, or `undefined` when values and advice disagree or either part is unreadable. */
export function decodePreferencePage(value: unknown): PreferenceReadingPage | undefined {
  const values = decodePreferenceValues(value);
  const advice = decodePreferenceAdvice(value);
  if (!values || !advice) return undefined;
  if (
    advice.reading.effective.spoilerLevel !== values.spoilerLevel ||
    advice.reading.effective.suitability !== values.suitability
  )
    return undefined;
  return { ...values, ...advice };
}
