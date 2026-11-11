import { useMemo } from 'react';
import { HostedBookReader, type HostedBookReaderProps } from './hosted-book-reader';
import { createNativeHostedBookSource, type NativeHostedBookAdmissionSource } from './native-source';

export type NativeHostedBookReaderProps = Omit<HostedBookReaderProps, 'source' | 'readingIdentity'> & {
  admission: NativeHostedBookAdmissionSource;
};

/** The host supplies real publication/target admission and prepared-viewer observations for this mount. */
export function NativeHostedBookReader({ admission, ...props }: NativeHostedBookReaderProps) {
  const source = useMemo(() => createNativeHostedBookSource(admission), [admission]);
  return <HostedBookReader {...props} source={source} readingIdentity={admission} />;
}
