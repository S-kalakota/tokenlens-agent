import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { classifyPrompt } from './categorical.mjs';
import {
  loadRepoIdMap,
  resolveModelId,
  resolveRepositoryIdentity,
} from './identities.mjs';
import { resolveMentionedFiles } from './mentions.mjs';
import { promptMetrics } from './prompt-structure.mjs';
import { resolveRelevantCode } from './references.mjs';
import { collectRepositoryMetrics } from './repository.mjs';
import { loadFeatureSchema, validatePayloadSchema } from './schema-validation.mjs';
import { countTokens, normalizeNewlines, tokenizerLabel } from './tokenizer.mjs';
import { validateFeatureManifest, validateFeaturePayload } from './validation.mjs';
import { readContextState } from '../transcript.mjs';

const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL('../../model/feature-manifest.json', import.meta.url),
);

const INCOMPLETE_WARNINGS = new Set([
  'model_id_unavailable',
  'mention_file_count_limit',
  'mention_total_size_limit',
  'repository_file_count_limit',
  'workspace_unavailable',
  'repository_unavailable',
  'repository_origin_unavailable',
  'repository_origin_unsupported',
  'repository_id_unknown',
  'repository_file_list_unavailable',
  'repository_total_size_limit',
  'reference_file_count_limit',
  'reference_total_size_limit',
]);

export async function loadFeatureManifest(path = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  return validateFeatureManifest(manifest);
}

/**
 * Collects the canonical, named v1 feature payload. Source text and paths may
 * exist in collector-local values while this function runs, but neither is
 * copied into the returned payload or persisted by this layer.
 */
export async function buildFeatures(
  {
    prompt = '',
    cwd,
    modelId,
    transcriptPath,
    manifest: suppliedManifest,
    schema: suppliedSchema,
    repoIdMap: suppliedRepoIdMap,
  } = {},
  dependencyOverrides = {},
) {
  const dependencies = {
    classifyPrompt,
    collectRepositoryMetrics,
    countTokens,
    loadFeatureManifest,
    loadFeatureSchema,
    loadRepoIdMap,
    now: () => Date.now(),
    promptMetrics,
    readContextState,
    resolveMentionedFiles,
    resolveModelId,
    resolveRelevantCode,
    resolveRepositoryIdentity,
    tokenizerLabel,
    validatePayloadSchema,
    ...dependencyOverrides,
  };

  const startedAt = dependencies.now();
  const manifest = suppliedManifest ?? (await dependencies.loadFeatureManifest());
  validateFeatureManifest(manifest);
  const schema = suppliedSchema ?? (await dependencies.loadFeatureSchema(manifest.payload_schema));
  const rawPrompt = normalizeNewlines(prompt);
  const tokenCounter = (text) => dependencies.countTokens(text, manifest.tokenizer);

  let transcriptModel = modelId;
  const earlyWarnings = ['single_root_only'];
  if (manifest.compatibility_status !== 'training-locked') {
    earlyWarnings.push('training_contract_provisional');
  }
  if (transcriptModel === undefined) {
    try {
      const context = await dependencies.readContextState(transcriptPath);
      transcriptModel = context?.model ?? null;
      if (context?.available !== true) earlyWarnings.push('model_id_unavailable');
    } catch {
      transcriptModel = null;
      earlyWarnings.push('model_id_unavailable');
    }
  }
  if (typeof transcriptModel !== 'string' || transcriptModel.trim() === '') {
    earlyWarnings.push('model_id_unavailable');
  }

  const repoIdMap = suppliedRepoIdMap ?? (await dependencies.loadRepoIdMap());
  const [identity, repository, mentioned] = await Promise.all([
    dependencies.resolveRepositoryIdentity({ cwd, manifest, repoIdMap }),
    dependencies.collectRepositoryMetrics({ cwd, manifest }),
    dependencies.resolveMentionedFiles({
      prompt: rawPrompt,
      cwd,
      manifest,
      countTokens: tokenCounter,
    }),
  ]);

  const relevant = await dependencies.resolveRelevantCode({
    prompt: rawPrompt,
    cwd,
    manifest,
    mentionedFiles: mentioned.files,
    countTokens: tokenCounter,
  });

  const normalizedModelId = dependencies.resolveModelId(transcriptModel, manifest);
  if (typeof transcriptModel !== 'string' || transcriptModel.trim() === '') {
    earlyWarnings.push('model_id_fallback');
  } else {
    // Claude Code exposes the model from the previous assistant message. A
    // just-issued /model switch cannot be observed by UserPromptSubmit yet.
    earlyWarnings.push('model_selection_may_lag');
  }

  const classifications = dependencies.classifyPrompt(rawPrompt, manifest);
  const structure = dependencies.promptMetrics(rawPrompt);
  const warnings = unique([
    ...earlyWarnings,
    ...(identity?.warnings ?? []),
    ...(repository?.warnings ?? []),
    ...(mentioned?.warnings ?? []),
    ...(relevant?.warnings ?? []),
  ]).sort();

  const features = {
    output_format: classifications.output_format,
    task_type: classifications.task_type,
    repo_id: identity?.repoId ?? manifest.defaults.repo_id,
    model_id: normalizedModelId,
    detail_level: classifications.detail_level,
    input_tokens: tokenCounter(rawPrompt),
    attached_code_tokens: safeCount(mentioned?.attachedCodeTokens),
    relevant_code_tokens: safeCount(relevant?.relevantCodeTokens),
    task_word_count: safeCount(structure.task_word_count),
    n_requirements: safeCount(structure.n_requirements),
    question_count: safeCount(structure.question_count),
    codebase_lines: safeCount(repository?.codebaseLines),
    codebase_files: safeCount(repository?.codebaseFiles),
    n_files_attached: safeCount(mentioned?.nFilesAttached),
  };

  const elapsed = dependencies.now() - startedAt;
  const payload = {
    schema_version: manifest.feature_schema_version,
    features,
    collection: {
      complete: !warnings.some((warning) => INCOMPLETE_WARNINGS.has(warning)),
      tokenizer: dependencies.tokenizerLabel(manifest.tokenizer),
      collector_version: manifest.collector_version,
      duration_ms: safeDuration(elapsed),
      warnings,
      parsers: { ...manifest.parsers },
      attachment_semantics: manifest.attachment_semantics,
    },
  };

  dependencies.validatePayloadSchema(payload, schema);
  return validateFeaturePayload(payload, manifest);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeDuration(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}
