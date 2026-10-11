# API-built profile corpora

`work-profile-corpus.ts` owns the axes, 4/16/64 population checkpoints
(2/8/32 history revisions), corpus identity and preparation deadline. Recipes
supply public commands and API verification; the backup driver and catalogue
backup only retain and restore stopped owner stores. Stable entity identities
belong to the retained backup: isolated restores preserve them, while a fresh
API build generates new ids.
