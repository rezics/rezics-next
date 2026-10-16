import { checkOccurrenceQualifier, InvalidStructureObject, type OccurrenceRecord } from '../structure/format.ts';

/** Recipe relations supplement the shared qualifier envelope on every ingress and read. */
export function checkRecipeQualifier(value: unknown): NonNullable<OccurrenceRecord['qualifier']> {
  const checked = checkOccurrenceQualifier(value);
  if (checked.type === 'ingredient-line' && checked.amountUpper !== undefined && checked.amount === undefined) {
    throw new InvalidStructureObject('an amount range needs its lower bound');
  }
  if (checked.type === 'ingredient-line' && checked.textParts) {
    const parts = checked.textParts, source = checked.originalText.value;
    const spans = [parts.amount, parts.name, ...(parts.unit ? [parts.unit] : [])];
    if (spans.some(span => span.start > span.end || span.end > source.length)
      || parts.amount.start === parts.amount.end || parts.amount.end > (parts.unit?.start ?? parts.name.start)
      || (parts.unit?.end ?? parts.amount.end) > parts.name.start) {
      throw new InvalidStructureObject('ingredient text spans differ from their retained source');
    }
  }
  return checked;
}
