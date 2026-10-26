const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function copiesSubjectId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length === 36 && uuid.test(value) ? value : undefined;
}
