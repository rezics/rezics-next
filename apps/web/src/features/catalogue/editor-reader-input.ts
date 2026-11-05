import { expectedCandidateReader } from '../../subject/candidate-admission';

/** Preserve the existing validator and native input. The extra field is only a mismatch guard. */
export function originalReaderInput<Input, Output extends object>(validate: (input: Input) => Output) {
  return (input: Input & { expectedReader?: string }): Output & { expectedReader: string } => {
    const expectedReader = expectedCandidateReader(input);
    const { expectedReader: _reader, ...native } = input as object & { expectedReader: string };
    return { ...validate(native as Input), expectedReader };
  };
}
