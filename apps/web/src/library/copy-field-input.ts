export const copyTextFieldLimits = { location: 200, source: 200, note: 1000 } as const;

export type CopyTextField = keyof typeof copyTextFieldLimits;

export function copyFieldInputIsTooLong(field: CopyTextField, value: string): boolean {
  return Array.from(value).length > copyTextFieldLimits[field];
}
