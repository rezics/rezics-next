# Notification channel decisions still pending

The [notification owner](../../services/main/src/modules/notification/README.md)
implements recipient intents, inbox/read state, push delivery, current disclosure
checks and uncertain provider reconciliation. Account security/recovery mail is a
separate purpose and [operator rollout](../operations/deployment.md#email-rollout)
selects its sender.

Before optional email rollout, add an Account-verified address resolver, signed
preference/unsubscribe links with expiry and one-click subscription handling, and
provider suppression/complaint integration. Private preferences, blocks and muted
topics must apply to optional delivery; a source user or provider aggregate must
not create a native recipient.

Before webhook rollout, bind deliveries to installation scope and signed envelopes.
Keep addresses and tokens outside public RDF. If presence or typing is introduced,
give it expiry rather than permanent graph history. Qualify each new channel with
recipient changes, invalid endpoints, unsubscribe, disclosure loss, lost ACK and
restore before enabling it.
