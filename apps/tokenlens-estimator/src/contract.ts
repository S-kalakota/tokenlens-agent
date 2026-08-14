import { z } from 'zod';

export const accessModeSchema = z.enum(['api', 'subscription']);

const nonBlankString = (maximumLength: number) =>
  z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value.trim().length > 0, 'Must contain non-whitespace text');

export const estimateRequestSchema = z.object({
  prompt: nonBlankString(1_000_000),
  provider: z.literal('anthropic'),
  model: nonBlankString(256),
  accessMode: accessModeSchema,
  client: z.object({
    name: z.literal('tokenlens-cursor'),
    version: nonBlankString(64),
  }),
  preferences: z.object({
    currency: z.literal('USD'),
    budgetThreshold: z.number().finite().nonnegative().optional(),
  }),
});

export const readyEstimateSchema = z.object({
  estimateId: nonBlankString(256),
  status: z.literal('ready'),
  provider: z.literal('anthropic'),
  model: nonBlankString(256),
  accessMode: accessModeSchema,
  display: z.object({
    chipText: nonBlankString(160),
    title: nonBlankString(300),
    summary: nonBlankString(500),
    disclaimer: nonBlankString(1_000),
  }),
  budget: z.object({
    isOverThreshold: z.boolean(),
  }),
  metadata: z.object({
    estimatorVersion: nonBlankString(128),
    generatedAt: z.iso.datetime({ offset: true }),
  }),
});

export const endpointErrorResponseSchema = z.object({
  status: z.literal('error'),
  error: z.object({
    code: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
    message: nonBlankString(500),
  }),
});

export const estimateResponseSchema = z.discriminatedUnion('status', [
  readyEstimateSchema,
  endpointErrorResponseSchema,
]);

export type AccessMode = z.infer<typeof accessModeSchema>;
export type EstimateRequest = z.infer<typeof estimateRequestSchema>;
export type ReadyEstimate = z.infer<typeof readyEstimateSchema>;
export type EndpointErrorResponse = z.infer<typeof endpointErrorResponseSchema>;
export type EstimateResponse = z.infer<typeof estimateResponseSchema>;

export interface EstimateRequestInput {
  prompt: string;
  model: string;
  accessMode: AccessMode;
  clientVersion: string;
  budgetThreshold?: number;
}

export function buildEstimateRequest(input: EstimateRequestInput): EstimateRequest {
  const preferences: EstimateRequest['preferences'] = {
    currency: 'USD',
    ...(input.budgetThreshold === undefined
      ? {}
      : { budgetThreshold: input.budgetThreshold }),
  };

  return estimateRequestSchema.parse({
    prompt: input.prompt,
    provider: 'anthropic',
    model: input.model,
    accessMode: input.accessMode,
    client: {
      name: 'tokenlens-cursor',
      version: input.clientVersion,
    },
    preferences,
  });
}
