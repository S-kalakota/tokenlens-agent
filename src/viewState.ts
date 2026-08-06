import type { PromptEstimate } from './simpleEstimator';

export type EstimateViewState =
  | { kind: 'disabled' }
  | { kind: 'permission-missing' }
  | { kind: 'paused' }
  | { kind: 'waiting-for-chat' }
  | { kind: 'draft-empty' }
  | { kind: 'estimate'; estimate: PromptEstimate }
  | { kind: 'unavailable'; reason?: string };
