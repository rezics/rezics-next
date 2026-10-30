import type { SearchScope } from './types';

/** A label is not search authority. Only a caller's existing local scoped route can submit a scoped query. */
export function headerSearchAction(locale: string, scope?: SearchScope): string | undefined {
  if (!scope) return `/${locale}/search`;
  const action = scope.searchAction;
  return action?.startsWith('/') && !action.startsWith('//') && !/[\\\r\n]/.test(action) ? action : undefined;
}

/** Empty-input Backspace is the same explicit scope removal as the chip's remove button. */
export function removesHeaderScope(key: string, query: string, scope?: SearchScope): boolean {
  return key === 'Backspace' && query.length === 0 && Boolean(scope);
}
