# History

## Recovered Account identity serializers

The original Account command and its later `access.agent-identity.recover` command have separate native cuts. The
original finite `core.agent_identity_inventory` still describes only its 2..3 actual serializers and its SDK
obligation stays independent. Recovery never fills a missing original cut or asserts the old SDK enqueue seam.

`declareAgentIdentityInventory` dispatches recovery declarations to a private writer that inserts one
`core.agent_identity_recovery_inventory` row under the original source key. It binds the immutable source digest,
recovery partition/epoch/position/transaction/receipt codec, request digest, current owner epoch and restore domain.
The expected receipt and single account-updated event are captured before serialization by
`captureAgentIdentityInventory`; actual serialized rows are associated by `recordCommandHistory`; the executor
seals the two-slot cut with `finalizeAgentIdentityInventory` before COMMIT. This uses the installed command
executor hooks; the private callback state is only a pre-serialization declaration. The real locator rows retain
the complete merged role set, with one 64-role bound per artifact. The primary key allows one recovery cut per
original key, and exact replay makes no additional serializer rows or recovery event.

The current read/retirement exports are `readAgentIdentityRecoveryInventoryInTransaction`,
`readAgentIdentityRecoveryArtifactInTransaction`, `readAgentIdentityRecoveryInventory`,
`verifyAgentIdentityRecoveryInventory` and `verifyAgentIdentityRecoveryArtifactReadiness`.
`verifyAgentIdentityRecoveryCopyInventory` is the Access owner adapter. These functions bind reads to the exact
source and recovery keys; released receipts are rechecked in the final same-home command. An absent recovery
snapshot is reread under that command after charging its 2/2/1/512 cost; the Source/Account writer locks remain
held through COMMIT. A retained old recovery without a sealed discriminator is pending.

The fixed recovery read costs are literal reservations at their dispatch points:

| Operation                                                         | Native work (rows / points / statements / bytes / engine requests) |
| ----------------------------------------------------------------- | -----------------------------------------------------------------: |
| Native inventory snapshot, once per exact source key              |                                          135 / 135 / 6 / 32768 / 0 |
| Artifact association probe, before returning absent or continuing |                                                2 / 2 / 1 / 512 / 0 |
| Unique association's exact cut reread                             |                                          135 / 135 / 6 / 32768 / 0 |
| Final same-home proof/owner/restore/receipt verification          |                                         275 / 275 / 18 / 49152 / 0 |
| Recovery owner readiness after cut resolution                     |                                         100 / 100 / 36 / 24576 / 0 |
| One non-durable serializer receiving receipt read                 |                                           76 / 75 / 12 / 24576 / 0 |

The recovery readiness reservation includes the exact effects/`account_discovery_redrive` consumer probes; its
event consumer ceiling is 32 plus the refusal sentinel. It then refuses for missing Search current-enrollment
authority. The original verification/reversal event path retains its separate 8/8/1/16384/0 full-key association,
69/69/4/24576/0 native artifact lock, and 76/75/13/131872/0 durable receiver plus existing History guard/absence
costs per actual consumer. Recovery does not invoke or inherit that original SDK receiver. These costs repeat for
every actual read and final verification; a failed prefix is not refunded. Source owner composition, when active,
reserves before dispatch against its existing frame and deadline. Missing, expired or exhausted Source funding
raises `identity-history-native-funding-unavailable`; a deadline-only independent History caller retains its own
owner allocation.

History validates the exact account-discovery effect row/workflow and effects checkpoint, then must also verify
Search's current discovery enrollment through a released owner observation and a final same-home result. No such
Search owner capability is installed in this composition. A checkpoint does not identify the current consumer
set, and a Search generation list read while holding an Account home is not authority. Therefore the actual gap is
`agent-identity-recovery-discovery-owner-unavailable` and the Recovery serializers remain pending for retention.
The account-updated recovery event is not an original verification/reversal handoff and cannot create a new SDK
obligation. This History module does not claim physical deletion, original SDK closure or whole Source completion.

The recovery writer is suppressed inside an active Semantic Source maintenance frame until its complete original
Source/History aggregate is funded. Five existing current verifier entries alone require 696320 bytes against the
unchanged 630784-byte allowance. The previous 11588/9856/2731/6843136/0 selected consumer body is not the final
aggregate. The current implementation does not alter prices, configured limits, or any unrelated owner budget.
