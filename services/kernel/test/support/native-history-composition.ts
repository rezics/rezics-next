import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { installIdentityRatingRepairProducer } from '../../src/composition/identity-rating-repair.ts';

/** Kernel tests load this before any command. It binds the same History WeakMap as server and worker. */
installNativeHistoryPreload();
installIdentityRatingRepairProducer();
