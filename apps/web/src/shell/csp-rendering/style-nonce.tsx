import { createContext, useContext, type ReactNode } from 'react';

const ShellStyleNonceContext = createContext<string | undefined>(undefined);

export function ShellStyleNonceProvider({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  return <ShellStyleNonceContext.Provider value={nonce}>{children}</ShellStyleNonceContext.Provider>;
}

export function useShellStyleNonce(): string | undefined {
  return useContext(ShellStyleNonceContext);
}
