/** Leaf maps so Access can install identity bridges before the owner modules finish evaluating. */
export const durableIdentityProofs = new WeakMap<object, object>();
export const durableIdentityBridges = new WeakMap<object, object>();
export const approvalIdentityProofs = new WeakMap<object, object>();
export const approvalIdentityBridges = new WeakMap<object, object>();
