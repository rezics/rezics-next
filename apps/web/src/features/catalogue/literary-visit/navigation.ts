export type LiteraryPreviousAddress = {
  view: 'overview' | 'contents' | 'editions';
  node?: string;
  cursor?: string;
  streamProperty?: string;
  streamDirection?: 'forward' | 'inverse';
  focus?: string;
};

export type LiteraryVisitLocation = {
  context?: string;
  hasContext: boolean;
  focus?: string;
  previous: LiteraryPreviousAddress[];
  invalid: boolean;
};

export const literaryPreviousLimit = 8;

const nodeToken = /^[A-Za-z0-9_-]{1,64}$/u;
const focusToken = /^[A-Za-z0-9:._~-]{1,256}$/u;
const safeCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);

function previousAddress(value: unknown): value is LiteraryPreviousAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  return (
    keys.every((key) => ['view', 'node', 'cursor', 'streamProperty', 'streamDirection', 'focus'].includes(key)) &&
    (item.view === 'overview' || item.view === 'contents' || item.view === 'editions') &&
    (item.node === undefined || (typeof item.node === 'string' && nodeToken.test(item.node))) &&
    (item.cursor === undefined || (item.node !== undefined && safeCursor(item.cursor))) &&
    ((item.streamProperty === undefined && item.streamDirection === undefined) ||
      (item.node !== undefined &&
        typeof item.streamProperty === 'string' &&
        item.streamProperty.trim().length > 0 &&
        item.streamProperty.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(item.streamProperty) &&
        (item.streamDirection === 'forward' || item.streamDirection === 'inverse'))) &&
    (item.view !== 'overview' ||
      (item.cursor === undefined &&
        ((item.node === undefined && item.streamProperty === undefined && item.streamDirection === undefined) ||
          (item.node !== undefined && item.streamProperty !== undefined && item.streamDirection !== undefined)))) &&
    (item.focus === undefined || (typeof item.focus === 'string' && focusToken.test(item.focus)))
  );
}

/** Parse only address intent. History contains bounded cursors, never rows or prior authorized payloads. */
export function literaryVisitLocation(search: string): LiteraryVisitLocation {
  const params = new URLSearchParams(search);
  const unique = (key: string) => params.getAll(key).length <= 1;
  const contextValues = params.getAll('context');
  const focusValues = params.getAll('focus');
  const historyValues = params.getAll('history');
  let invalid = !unique('context') || !unique('focus') || !unique('history');
  const context = contextValues[0];
  if (context !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(context))
    invalid = true;
  const focus = focusValues[0];
  if (focus !== undefined && !focusToken.test(focus)) invalid = true;
  let previous: LiteraryPreviousAddress[] = [];
  const serialized = historyValues[0];
  if (serialized !== undefined) {
    try {
      const value: unknown = JSON.parse(serialized);
      if (
        serialized.length > 32768 ||
        !Array.isArray(value) ||
        value.length > literaryPreviousLimit ||
        !value.every(previousAddress)
      )
        invalid = true;
      else previous = value;
    } catch {
      invalid = true;
    }
  }
  return {
    ...(context === undefined ? {} : { context }),
    hasContext: contextValues.length > 0,
    ...(focus === undefined ? {} : { focus }),
    previous: invalid ? [] : previous,
    invalid,
  };
}

export function appendLiteraryPrevious(
  previous: readonly LiteraryPreviousAddress[],
  current: LiteraryPreviousAddress,
): LiteraryPreviousAddress[] {
  return [...previous, current].slice(-literaryPreviousLimit);
}

export function literaryFocusId(focus: string): string {
  return `literary-row-${encodeURIComponent(focus)}`;
}
