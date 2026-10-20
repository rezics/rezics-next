import { expect, test } from 'bun:test';

test('native retained validation reads explicit results instead of invoking provider transformations', async () => {
  for (const file of ['field-support-retained.ts','field-support-evidence.ts']) {
    const source = await Bun.file(`services/main/src/modules/source/${file}`).text();
    expect(source).not.toContain('retainedFieldPlan');
    expect(source).not.toContain('convertProviderRecord');
    expect(source).toContain('evidence.fieldPlan');
  }
  const source = await Bun.file('services/main/src/modules/source/retained-record.ts').text();
  const nativeRead = source.slice(source.indexOf('  async evidence('));
  expect(nativeRead).not.toContain('verifyRetainedRecord(');
  expect(nativeRead).not.toContain('retainedFieldPlan(');
  expect(nativeRead).toContain('verifyRetainedEvidence(');
});

test('legacy native source reads also validate saved conversion output without transforming the provider again', async () => {
  const source = await Bun.file('services/main/src/modules/source/open-library-conversion.ts').text();
  const mapped = source.slice(source.indexOf('  async mappedRead('),source.indexOf('  private async projectMapped('));
  expect(mapped).not.toContain('this.projectMapped('); expect(mapped).toContain('this.validateMapped(');
  const verified = source.slice(source.indexOf('  async verifiedRead('),source.indexOf('  async compare('));
  expect(verified).not.toContain('projectOpenLibraryWork('); expect(verified).toContain('verifyConversionBytes(');
});
