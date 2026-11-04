/** A lease records one visit. Equal addresses or account IDs never reactivate it. */
export type AddressLease = { current: () => boolean; retire: () => void };
export type ReadLease = { reader: string; current: () => boolean };
export type OperationLease<Operation extends string> = ReadLease & {
  operation: Operation;
  credential: () => string | null;
};

export function addressLease(parent: () => boolean = () => true): AddressLease {
  let retired = false;
  return {
    retire: () => { retired = true; },
    current: () => {
      // Once observed false, even a parent returning to the same value cannot revive this visit.
      if (!parent()) retired = true;
      return !retired;
    },
  };
}

/** Read admission deliberately does not inspect mutation credentials. */
export function readLease(reader: string, address: AddressLease, admitted: () => boolean): ReadLease {
  return { reader, current: () => !!reader && address.current() && admitted() };
}

/** This is browser dispatch fencing. The server still prepares and authenticates its own request. */
export function operationLease<Operation extends string>(
  read: ReadLease,
  operation: Operation,
  admitted: () => boolean,
  credential: () => string | null,
): OperationLease<Operation> {
  const current = () => read.current() && admitted();
  return { reader: read.reader, operation, current, credential: () => current() ? credential() : null };
}
