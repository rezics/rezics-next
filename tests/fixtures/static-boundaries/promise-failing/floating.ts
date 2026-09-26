async function save(): Promise<void> {}

export function run(values: number[]): void {
  save();
  values.forEach(async () => {
    await save();
  });
}
