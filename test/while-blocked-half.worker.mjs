// Half a whileBlocked hook — a `pending` with no `run` — which is what
// while-blocked.test.mjs's refusal case needs an actual worker module for.
import { serve } from '../src/worker.mjs';

serve({ whileBlocked: { pending: () => false } });
