import type { KernelClient } from '@rezics/client';
import { QUESTION } from './question-ids';
import type { RatingQuestion } from './question-contract';

export async function readRatingQuestion(client: KernelClient): Promise<RatingQuestion | null> {
  const result = await client['rating-questions']({ questionId: QUESTION }).get();
  return result.status === 200 && result.data ? result.data : null;
}
