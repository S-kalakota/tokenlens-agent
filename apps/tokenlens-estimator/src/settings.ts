import * as vscode from 'vscode';
import type { AccessMode } from './contract';
import type { EstimatorMode } from './client/clientFactory';
import type { MockScenario } from './client/mockFixtures';

export interface TokenLensSettings {
  estimatorMode: EstimatorMode;
  endpoint: string;
  model: string;
  accessMode: AccessMode;
  budgetThreshold?: number;
  requestTimeoutMs: number;
  mockScenario: MockScenario;
  mockDelayMs: number;
}

const ESTIMATOR_MODES: readonly EstimatorMode[] = ['mock', 'endpoint'];
const ACCESS_MODES: readonly AccessMode[] = ['subscription', 'api'];
const MOCK_SCENARIOS: readonly MockScenario[] = [
  'auto',
  'api-ready',
  'subscription-ready',
  'over-budget',
  'unavailable',
  'malformed',
];

export function readTokenLensSettings(): TokenLensSettings {
  const configuration = vscode.workspace.getConfiguration('tokenlens');
  const budgetThreshold = configuration.get<number | null>('budgetThreshold', null);

  return {
    estimatorMode: enumSetting(
      configuration.get<string>('estimatorMode'),
      ESTIMATOR_MODES,
      'mock',
    ),
    endpoint: configuration.get<string>(
      'endpoint',
      'http://localhost:8787/v1/estimates',
    ),
    model: configuration.get<string>('model', 'claude-sonnet-4'),
    accessMode: enumSetting(
      configuration.get<string>('accessMode'),
      ACCESS_MODES,
      'subscription',
    ),
    ...(typeof budgetThreshold === 'number' &&
    Number.isFinite(budgetThreshold) &&
    budgetThreshold >= 0
      ? { budgetThreshold }
      : {}),
    requestTimeoutMs: clamp(
      configuration.get<number>('requestTimeoutMs', 8_000),
      500,
      60_000,
    ),
    mockScenario: enumSetting(
      configuration.get<string>('mockScenario'),
      MOCK_SCENARIOS,
      'auto',
    ),
    mockDelayMs: clamp(
      configuration.get<number>('mockDelayMs', 650),
      0,
      30_000,
    ),
  };
}

function enumSetting<T extends string>(
  value: string | undefined,
  allowedValues: readonly T[],
  fallback: T,
): T {
  return value !== undefined && allowedValues.includes(value as T)
    ? (value as T)
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}
