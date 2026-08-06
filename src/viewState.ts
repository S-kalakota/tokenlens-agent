import type { PromptEstimate } from './simpleEstimator';

export type EstimateViewState =
  | { kind: 'idle' }
  | { kind: 'blocked'; estimate: PromptEstimate };
