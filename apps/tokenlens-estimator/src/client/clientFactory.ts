import { HttpEstimatorClient, type FetchImplementation } from './httpEstimatorClient';
import { MockEstimatorClient } from './mockEstimatorClient';
import type { MockScenario } from './mockFixtures';
import type { EstimatorClient } from './types';

export type EstimatorMode = 'mock' | 'endpoint';

export interface EstimatorClientConfiguration {
  mode: EstimatorMode;
  endpoint: string;
  mockScenario: MockScenario;
  mockDelayMs: number;
}

export function createEstimatorClient(
  configuration: EstimatorClientConfiguration,
  fetchImplementation?: FetchImplementation,
): EstimatorClient {
  if (configuration.mode === 'mock') {
    return new MockEstimatorClient(
      configuration.mockScenario,
      configuration.mockDelayMs,
    );
  }

  return fetchImplementation === undefined
    ? new HttpEstimatorClient(configuration.endpoint)
    : new HttpEstimatorClient(configuration.endpoint, fetchImplementation);
}
