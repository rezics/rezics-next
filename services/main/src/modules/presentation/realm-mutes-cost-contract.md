# Realm mute presentation filter cost contract

`createPresentationMuteFilter` consumes at most the Access owner's 256 active
mutes. It indexes each match by target once, using `O(m)` time and memory for
`m ≤ 256`. For `k` candidate presentation items and `a` author-membership Realm
facts per item, filtering performs `O(k × (1 + a))` Set lookups and returns at
most `k` items. It does not make owner calls, alter candidate order, or truncate
results. Its caller must keep the read's candidate set bounded and obtain the
mute list from Access for the same verified principal. An unavailable Access
read must fail the personalized presentation closed rather than fall back to an
unfiltered result. This helper alone does not establish a route-level cost bound
or prove integration with a feed/search owner.
