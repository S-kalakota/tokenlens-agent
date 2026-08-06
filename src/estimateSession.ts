import type { EstimateRequest, ReadyEstimate } from './contract';
import {
  estimateFailure,
  type EstimatorClient,
  type EstimatorError,
} from './client/types';

export type EstimateViewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; estimate: ReadyEstimate }
  | { kind: 'unavailable'; error: EstimatorError };

export class EstimateSession {
  private generation = 0;
  private activeController: AbortController | undefined;

  public constructor(
    private readonly updateView: (state: EstimateViewState) => void,
  ) {}

  public async run(
    client: EstimatorClient,
    request: EstimateRequest,
    timeoutMs: number,
  ): Promise<void> {
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const generation = ++this.generation;
    this.updateView({ kind: 'loading' });

    try {
      const result = await client.estimate(request, {
        signal: controller.signal,
        timeoutMs,
      });

      if (generation !== this.generation) {
        return;
      }

      this.activeController = undefined;
      if (result.ok) {
        this.updateView({ kind: 'ready', estimate: result.value });
      } else if (result.error.kind === 'cancelled') {
        this.updateView({ kind: 'idle' });
      } else {
        this.updateView({ kind: 'unavailable', error: result.error });
      }
    } catch {
      if (generation === this.generation) {
        this.activeController = undefined;
        const result = estimateFailure(
          'network',
          'The estimator endpoint is unavailable.',
          true,
        );
        if (!result.ok) {
          this.updateView({ kind: 'unavailable', error: result.error });
        }
      }
    }
  }

  public showFailure(error: EstimatorError): void {
    this.activeController?.abort();
    this.activeController = undefined;
    this.generation += 1;
    this.updateView({ kind: 'unavailable', error });
  }

  public reset(): void {
    this.activeController?.abort();
    this.activeController = undefined;
    this.generation += 1;
    this.updateView({ kind: 'idle' });
  }

  public dispose(): void {
    this.activeController?.abort();
    this.activeController = undefined;
    this.generation += 1;
  }

  public get isLoading(): boolean {
    return this.activeController !== undefined;
  }
}
