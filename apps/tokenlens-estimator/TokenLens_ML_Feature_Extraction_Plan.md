# TokenLens Claude Code CLI ML Feature Extraction Plan

## Purpose

Extend the existing TokenLens Claude Code plugin with a deterministic feature-extraction layer for the trained ML model.

This document is intentionally limited to two responsibilities:

1. Extract the model's 14 input features from the Claude Code `UserPromptSubmit` hook event and the local workspace.
2. Serialize and validate those features in a stable format that can be converted into one ordered row for the ML model.

The existing Claude Code behavior remains unchanged: the first Enter estimates and pauses a prompt, recalling it with Up and pressing Enter submits it unchanged, and an edited prompt is extracted and estimated again.

This plan does not define model training, model evaluation, pricing, the terminal UI, or a new confirmation flow.

## Exact Model Features

The feature order is fixed and must match the order expected by the trained model:

```python
FEATURE_ORDER = [
    "output_format",
    "task_type",
    "repo_id",
    "model_id",
    "detail_level",
    "input_tokens",
    "attached_code_tokens",
    "relevant_code_tokens",
    "task_word_count",
    "n_requirements",
    "question_count",
    "codebase_lines",
    "codebase_files",
    "n_files_attached",
]
```

No collector may rename, omit, or silently add a model feature. JSON property order is not meaningful; the adapter always creates the model row from the manifest's `feature_order`. Collection metadata may exist outside the `features` object, but it must not become an input column unless the model and feature schema are versioned together.

## Claude Code Inputs

The existing `claude-code/scripts/gate.mjs` hook reads a `UserPromptSubmit` event as JSON on stdin. The fields needed by the feature collectors are:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "session-uuid",
  "transcript_path": "/Users/me/.claude/projects/-Users-me-repo/session-uuid.jsonl",
  "cwd": "/absolute/workspace",
  "permission_mode": "default",
  "prompt": "Refactor @src/parser.ts and return a concise patch."
}
```

This payload is materially smaller than the Cursor `beforeSubmitPrompt` object the earlier draft of this plan assumed. Three differences drive the rest of the design:

- **There is no `attachments` array.** Claude Code expands `@` mentions into file content *after* the hook runs, so the hook sees the literal `@src/parser.ts` text inside `prompt`. Attachment features must be recovered by parsing the prompt.
- **There is no `model_id` field.** The selected model is recovered from the session transcript, exactly as `claude-code/src/transcript.mjs` already does for pricing.
- **There is no `workspace_roots` array.** `cwd` is the single supplied root. Directories added with `/add-dir` are not reported to the hook.

Use `cwd` as the scan and path-containment boundary. Do not assume the hook process's current directory is the user's repository, because Claude Code launches plugin hooks with `${CLAUDE_PLUGIN_ROOT}` paths and the process cwd is not a contract.

`permission_mode` is available but is not one of the 14 features. Do not add it as an input column.

The feature extractor must work when optional fields are missing. It should return explicit `unknown` categorical values or documented numeric defaults instead of throwing and blocking Claude Code.

### Version-Sensitive Assumption

That `@` mentions reach the hook unexpanded is a behavior of the installed Claude Code version, not a documented stable contract. Pin it with a fixture-backed integration test that captures a real hook payload for a prompt containing an `@` mention, and re-run it on Claude Code upgrades. If a future version expands mentions before the hook, the attachment collectors switch to reading the expanded content and the parser becomes a fallback.

## Extraction Pipeline

```text
Claude Code UserPromptSubmit input
        |
        +-- prompt text
        +-- cwd
        +-- transcript path
        |
        v
Normalize input
        +-- validate hook fields
        +-- normalize prompt newlines
        +-- parse and deduplicate @ file mentions
        +-- resolve repository root from cwd
        +-- read model id from transcript
        |
        v
Feature collectors
        +-- categorical prompt classifier
        +-- prompt/token metrics
        +-- mentioned/relevant code metrics
        +-- repository metrics
        +-- model/repository identity resolver
        |
        v
Named tokenlens.ml-features.v1 JSON
        |
        +-- schema validation
        +-- type/range validation
        +-- categorical vocabulary validation
        |
        v
ML adapter
        +-- read FEATURE_ORDER from model manifest
        +-- build exactly one ordered row
        +-- run saved preprocessing pipeline + model
```

The named JSON object is the canonical interface between the Claude Code plugin and the ML runtime. The model adapter, not the collector, is responsible for ordering columns and loading the training-time preprocessing pipeline.

## Canonical Feature Payload

The extractor returns one named, versioned object:

```json
{
  "schema_version": "tokenlens.ml-features.v1",
  "features": {
    "output_format": "patch",
    "task_type": "refactor",
    "repo_id": "cursor_token_price_estimator",
    "model_id": "claude-opus-5",
    "detail_level": "concise",
    "input_tokens": 24,
    "attached_code_tokens": 1380,
    "relevant_code_tokens": 1380,
    "task_word_count": 8,
    "n_requirements": 2,
    "question_count": 0,
    "codebase_lines": 18422,
    "codebase_files": 142,
    "n_files_attached": 1
  },
  "collection": {
    "complete": true,
    "tokenizer": "training-tokenizer-name@version",
    "collector_version": "1.0.0",
    "duration_ms": 73,
    "warnings": []
  }
}
```

Only the object under `features` is passed to the ML preprocessing pipeline. The `collection` object exists for validation and debugging and must never be included accidentally as model input.

## Feature Definitions

| Feature | Type | Claude Code/local source | Default | Definition |
| --- | --- | --- | --- | --- |
| `output_format` | categorical string | Prompt | `unspecified` | Explicitly requested response format, classified with the model manifest's vocabulary |
| `task_type` | categorical string | Prompt | `other` | Primary work requested by the prompt |
| `repo_id` | categorical string | Git metadata plus model mapping | `unknown` | Model-facing ID for the repository or workspace |
| `model_id` | categorical string | Transcript's last assistant message | `unknown` | Model answering this session; `unknown` before the first assistant turn |
| `detail_level` | categorical string | Prompt | `standard` | Requested response depth or verbosity |
| `input_tokens` | non-negative integer | Prompt | `0` | Token count of the submitted prompt only |
| `attached_code_tokens` | non-negative integer | `@` file mentions | `0` | Tokens in unique valid code files mentioned in the current prompt |
| `relevant_code_tokens` | non-negative integer | `@` mentions plus explicit file/range references | `0` | Tokens in the union of code known to be relevant before submission |
| `task_word_count` | non-negative integer | Prompt prose | `0` | Word count of the task text outside fenced code blocks |
| `n_requirements` | non-negative integer | Prompt prose | `0` | Count of explicit, independently testable requirements |
| `question_count` | non-negative integer | Prompt prose | `0` | Count of question units outside code blocks |
| `codebase_lines` | non-negative integer | Workspace/repository | `0` with unavailable warning | Lines across included codebase files |
| `codebase_files` | non-negative integer | Workspace/repository | `0` with unavailable warning | Count of included codebase files |
| `n_files_attached` | non-negative integer | `@` file mentions | `0` | Unique valid file mentions in the current prompt |

The defaults above make the runtime robust, but they must match the missing-value behavior used during training. If training used `null`, a sentinel such as `-1`, or a dedicated missing category, the model manifest overrides these proposed defaults.

`model_id` deserves particular attention. Because Claude Code exposes no model field on the hook event, the first prompt of a session has no transcript usage record and therefore no model. If training never produced an `unknown` model row, the manifest must define the substitute — most likely the manifest's default model category, mirroring how `claude-code/src/pricing.mjs` falls back to Sonnet rather than emitting a zero.

## Model Feature Manifest

Store a manifest beside the trained model. It is the authoritative definition of column order, categorical values, tokenizer, types, and defaults.

```json
{
  "feature_schema_version": "tokenlens.ml-features.v1",
  "model_version": "tokenlens-cost-model-v1",
  "feature_order": [
    "output_format",
    "task_type",
    "repo_id",
    "model_id",
    "detail_level",
    "input_tokens",
    "attached_code_tokens",
    "relevant_code_tokens",
    "task_word_count",
    "n_requirements",
    "question_count",
    "codebase_lines",
    "codebase_files",
    "n_files_attached"
  ],
  "categorical_features": {
    "output_format": [
      "code",
      "json",
      "markdown",
      "patch",
      "plain_text",
      "table",
      "unspecified"
    ],
    "task_type": [
      "bug_fix",
      "configuration",
      "documentation",
      "explanation",
      "feature",
      "refactor",
      "research",
      "review",
      "test",
      "other"
    ],
    "detail_level": [
      "concise",
      "standard",
      "detailed"
    ]
  },
  "tokenizer": {
    "name": "training-tokenizer-name",
    "version": "training-tokenizer-version"
  }
}
```

The categorical lists shown above are a proposed v1 vocabulary. Before implementation, replace them with the exact labels accepted by the trained encoder. Do not train on one label set and infer with synonyms, different capitalization, or new labels.

The manifest should also contain:

- Allowed or mapped `repo_id` values.
- Allowed or aliased `model_id` values, including the pre-first-turn fallback.
- Numeric types and bounds.
- Missing-value behavior.
- Repository file inclusion rules.
- The exact line-count definition.
- The exact requirement and question parser versions.
- The saved preprocessing artifact name and checksum.

## Categorical Prompt Features

### `output_format`

Classify only the format the user asks Claude Code to produce. Do not infer a format from the repository language alone.

Suggested deterministic signals:

| Category | Prompt signals |
| --- | --- |
| `json` | “return JSON,” “JSON object,” “valid JSON” |
| `patch` | “show a patch,” “unified diff,” “diff only” |
| `markdown` | “write Markdown,” “README,” “markdown document” |
| `table` | “return a table,” “tabular format,” “CSV table” if the manifest maps CSV here |
| `code` | “implement,” “write the code,” “create the file,” when no more specific format is requested |
| `plain_text` | “plain text,” “explain in prose” |
| `unspecified` | No explicit or reliable output-format signal |

Rules:

1. Normalize prompt text to Unicode and lowercase for matching.
2. Ignore text inside fenced code blocks when classifying instructions.
3. Prefer explicit phrases such as “respond with JSON” over weak words such as a `.json` filename.
4. If multiple formats are requested, use a versioned precedence table from the manifest or the first explicit output instruction. Never choose nondeterministically.
5. Emit only a category accepted by the trained encoder.

### `task_type`

Classify the main action requested by the user.

Suggested deterministic categories and signals:

| Category | Strong signals |
| --- | --- |
| `bug_fix` | fix, debug, broken, error, regression, failing |
| `feature` | add, build, implement, create, support |
| `refactor` | refactor, restructure, simplify, clean up, reorganize |
| `test` | add tests, test coverage, write a test, reproduce with a test |
| `documentation` | document, README, guide, comments, API docs |
| `review` | review, audit, inspect, critique, find issues |
| `explanation` | explain, describe, how does, why does |
| `research` | investigate, compare options, research, evaluate approaches |
| `configuration` | configure, setup, manifest, CI setting, environment setting |
| `other` | No supported category has a reliable signal |

Use a versioned, testable classifier:

1. Strip fenced code blocks from the classification text.
2. Match phrases before individual words.
3. Score categories using the checked-in rules.
4. Use a fixed tie-break order when scores are equal.
5. Prefer the user's primary imperative clause over examples or background text.
6. Return `other` when confidence is below the fixed threshold.

The collector must not call another LLM to generate this feature in the prompt-submit path. That would add cost, latency, and nondeterminism before the estimate, and it would run inside the hook's 10-second timeout configured in `claude-code/hooks/hooks.json`.

### `detail_level`

Classify requested response depth:

- `concise`: explicit signals such as “brief,” “concise,” “minimal,” “short,” or “just the answer.”
- `detailed`: explicit signals such as “detailed,” “thorough,” “comprehensive,” “step-by-step,” “all edge cases,” or “production-ready.”
- `standard`: no explicit detail signal or conflicting signals.

Explicit user wording wins. Prompt length alone must not force `detailed`, because a long prompt can still request a short answer.

## Identity Features

### `repo_id`

`repo_id` is the model-facing repository category, not a local absolute path.

Extraction:

1. Normalize and resolve the hook's `cwd` to a real path.
2. Run `git -C <cwd> rev-parse --show-toplevel`.
3. Resolve the repository's configured origin with `git -C <root> remote get-url origin`.
4. Normalize supported GitHub HTTPS and SSH origins to a slug such as `owner/repository`.
5. Map the slug through a checked-in `repo-id-map.json` or the model manifest.
6. Emit the mapped training ID, never the absolute path or full remote URL.
7. Emit `unknown` when no mapping exists, when `cwd` is missing, or when `cwd` is not inside a Git repository.

Claude Code supplies exactly one `cwd` per hook event, so the multi-root case the Cursor draft handled does not arise from the hook payload. A session can still span directories added with `/add-dir`, but those are invisible here: v1 scopes `repo_id`, `codebase_files`, and `codebase_lines` to the `cwd` repository and records a `single_root_only` note in `collection.warnings`. If training used a `multi_repo` category, it is unreachable from this hook and should be dropped from the inference-time vocabulary.

If training used raw repository slugs rather than aliases, the manifest must state that explicitly. Private repository names should not be transmitted by default.

### `model_id`

Claude Code does not put the model on the hook event. Reuse the transcript reader that pricing already depends on — `readContextState(input.transcript_path)` in `claude-code/src/transcript.mjs` returns the `model` from the most recent assistant message.

Resolution order:

1. `model` from the last assistant turn in the session transcript.
2. The manifest's documented pre-first-turn fallback, when the transcript has no assistant turn yet, is unreadable, or is missing.
3. `unknown`, only if the manifest's encoder accepts it.

Normalize the resolved value through the model alias table: transcript ids carry date suffixes such as `claude-haiku-4-5-20251001`, and several ids may map to one training category. Do not derive `model_id` from the pricing family — `claude-code/src/pricing.mjs` deliberately collapses every unknown id onto Sonnet, which is correct for money and wrong for a categorical feature.

Because the transcript reports the model that answered the *previous* turn, a `/model` switch made just before this prompt is not visible until the next assistant message. Record that skew in `collection.warnings` rather than guessing.

## Token Features

### Shared Tokenizer Rule

`input_tokens`, `attached_code_tokens`, and `relevant_code_tokens` must use the same tokenizer and version used to build the training data.

Preferred implementation order:

1. Use the exact tokenizer library and vocabulary used during training.
2. If the training tokenizer is Python-only, provide a verified compatible local Node implementation or perform tokenization in a local preprocessing service before inference.
3. Use a character-based approximation only if the training data used the same approximation.

Never train with one tokenizer and infer with the four-characters-per-token estimator in `claude-code/src/estimator.mjs` unless those definitions are intentionally identical.

### `input_tokens`

Tokenize the exact submitted `prompt` string after normalizing newline representation only if training did the same. Do not include:

- Content expanded from `@` mentions.
- Transcript or conversation history.
- Repository files.
- `CLAUDE.md` files, output styles, MCP tool definitions, or the system prompt.

This feature represents only the current user input available to `UserPromptSubmit`. In particular, the carried context tokens that `readContextState` returns for pricing are *not* a model feature and must not be folded into `input_tokens` or added as a fifteenth column.

### `attached_code_tokens`

Claude Code has no attachment list, so the accepted set is built from the prompt text:

1. Parse `@` mentions from the prompt with a checked-in, versioned regular expression. Match only mentions at a token boundary, and stop at whitespace so trailing punctuation is not captured.
2. Skip mentions inside fenced code blocks and inline code, and skip email-like text such as `user@example.com`.
3. Skip Claude Code placeholders that are not file paths, including pasted-image markers such as `[Image #1]`.
4. Resolve each mention relative to `cwd`, then normalize and deduplicate by real path.
5. Require containment within `cwd`.
6. Reject traversal, symlink escape, non-regular files, directories, binary files, and files beyond configured size limits.
7. Read each accepted file locally.
8. Tokenize its content with the training tokenizer.
9. Sum each unique file once.

A directory mention such as `@src/` is not a file: it is excluded here and from `n_files_attached`, with a warning. Do not send mentioned source text in the feature payload.

### `relevant_code_tokens`

At pre-submit time TokenLens cannot know which files Claude Code will read, grep, or glob once the turn starts. This feature must therefore mean “code already identified as relevant before submission.”

The v1 relevant-code set is the union of:

- Valid unique `@` file mentions.
- Valid repository files explicitly referenced as bare paths in the prompt prose.
- Explicit line ranges such as `src/parser.ts:20-80` or `src/parser.ts#L20-L80`.

Rules:

1. Resolve references only inside `cwd`.
2. If a whole file is mentioned or referenced, include the whole file once.
3. If only ranges are referenced, clamp them to file bounds and merge overlapping or adjacent ranges.
4. If a whole file and a range in that file are both referenced, count the whole file once.
5. Concatenate selected content using the same separator used during training, then tokenize it once; or sum per-file/per-range counts only if tests prove equivalence for the tokenizer.
6. Return `0` when no valid relevant code is identified.

`attached_code_tokens` may be a subset of `relevant_code_tokens`. The two features intentionally overlap because they represent different model signals, and under Claude Code they collapse to the same value whenever the prompt uses only `@` mentions. That is expected, not a bug.

Do not include files that Claude Code might read in the future, semantic-search guesses, or every file in the repository.

## Prompt Structure Features

Create two prompt representations:

- `raw_prompt`: exact submitted text for `input_tokens`.
- `prose_prompt`: prompt with fenced code blocks replaced by whitespace while preserving line boundaries, used for word, requirement, question, and categorical parsing.

`@` mentions stay in `prose_prompt` as written. Whether the training parser counted `@src/parser.ts` as a word must be recorded in the manifest and reproduced exactly.

### `task_word_count`

Count Unicode word sequences in `prose_prompt` using a checked-in regular expression or `Intl.Segmenter` with a fixed locale and tested fallback. Paths, punctuation, and Markdown markers are not words. The same rule must be used in training and inference.

### `n_requirements`

Count explicit, independently actionable constraints in `prose_prompt`.

Recognized requirement units:

- Numbered-list items containing an action or constraint.
- Bullet-list items containing an action or constraint.
- Imperative clauses beginning with a supported action verb.
- Clauses containing strong requirement markers such as `must`, `need to`, `should`, `ensure`, `do not`, or `only`.

Parsing rules:

1. Split Markdown list items and prose sentences deterministically.
2. Ignore headings, empty list items, examples, and fenced code.
3. Do not count a question as a requirement unless it also contains an explicit action or constraint.
4. Count one list item as one requirement unless the training parser deliberately splits coordinated clauses.
5. Deduplicate the same span if it matches more than one rule.
6. Store the rule-set version in collection metadata.

Example:

```text
Refactor the parser.
- Preserve the public API.
- Add tests for empty input.
Do not add dependencies.
```

With a v1 clause-based definition, this contains four requirements.

### `question_count`

Count question units in `prose_prompt`:

1. Split prose into sentence-like units.
2. Count a unit ending in one or more `?` characters as one question.
3. Count `???` as one question, not three.
4. Ignore question marks inside URLs, inline code, escaped Markdown, and fenced code when the parser can identify them safely.
5. Do not infer an unstated question from a declarative request.

If the training pipeline simply counted `?` characters, reproduce that exact rule instead of using the richer parser above.

## Codebase Features

### Shared File Set

`codebase_lines` and `codebase_files` must be calculated from the same deduplicated file set.

For a Git repository, begin with:

```text
git -C <repository-root> ls-files -z
```

Include only the source, test, configuration, markup, query, and documentation extensions listed in the model manifest. Exclude:

- Binary files.
- Dependencies and generated output.
- Source maps and bundles.
- Lockfiles unless training included them.
- Files above the configured size limit.
- Symlinks escaping the repository.
- Secret/environment files.

The repository root is the Git top level resolved from `cwd`. For a non-Git `cwd`, use a bounded filesystem walk only if the training data used an equivalent rule; otherwise emit `0` with an unavailable warning.

### `codebase_files`

Count the files in the shared included file set after exclusions and deduplication.

### `codebase_lines`

Sum the line count of every file in the same set. The line definition must be recorded in the model manifest. Recommended v1 definition:

- Physical lines.
- Empty file: `0` lines.
- Non-empty file: newline count plus one when the file does not end in a newline.
- Blank lines and comments included.

If training used non-blank lines, `cloc`, or `tokei`, inference must use that exact definition instead.

### Repository Cache

Cache `codebase_files` and `codebase_lines` because they should not be recomputed on every Enter, and because the hook has a 10-second timeout. Use a cache key containing:

```text
repository identity
+ Git HEAD
+ working-tree fingerprint when uncommitted files are included
+ inclusion-rule version
+ line-count version
+ collector version
```

Store the cache under `tokenLensHome()` from `claude-code/src/config.mjs`, alongside the existing `pending/` state, and prune it on the same schedule. Cache entries must contain counts and file metadata only, never prompt text or source contents.

## Attachment Count

### `n_files_attached`

Count the same unique valid `@` file mentions used by `attached_code_tokens`:

- Count each real file once even if the prompt mentions it more than once.
- Do not count directory mentions.
- Do not count missing, external, binary, or rejected files.
- Do not count pasted-image placeholders.
- A valid zero-mention prompt produces `0`.

Keeping the mention count and token count on the same accepted file set prevents contradictions such as `n_files_attached: 0` with nonzero `attached_code_tokens`.

Note the semantic drift from training: if the model was trained on IDE-style attachments, a Claude Code `@` mention is the closest available analogue but not an identical signal. Record `mention_derived` in `collection.warnings` so that predictions made under this substitution can be identified later.

## Proposed Claude Code File Layout

```text
contracts/
└── ml-feature-payload.v1.schema.json

claude-code/model/
├── feature-manifest.json
└── repo-id-map.json

claude-code/src/features/
├── build-features.mjs
├── categorical.mjs
├── prompt-structure.mjs
├── tokenizer.mjs
├── mentions.mjs
├── references.mjs
├── repository.mjs
├── identities.mjs
├── cache.mjs
└── validation.mjs

claude-code/src/
└── ml-feature-adapter.mjs

claude-code/test/features/
├── build-features.test.mjs
├── categorical.test.mjs
├── prompt-structure.test.mjs
├── tokenizer.test.mjs
├── mentions.test.mjs
├── references.test.mjs
├── repository.test.mjs
├── identities.test.mjs
└── fixtures/
```

This mirrors the existing plugin layout: ES modules under `claude-code/src/`, `node:test` files under `claude-code/test/` ending in `.test.mjs`, and the hook entry point at `claude-code/scripts/gate.mjs`.

`build-features.mjs` should expose one main function:

```js
const payload = await buildFeatures({
  prompt: input.prompt,
  cwd: input.cwd,
  modelId: context.model,
  transcriptPath: input.transcript_path,
});
```

The returned payload must already pass the JSON Schema before it reaches the ML adapter.

## ML Parsing and Adapter Contract

The model runtime should consume named features, validate them, and then create an ordered row from the manifest.

Example Python adapter:

```python
import json
import pandas as pd


def to_model_frame(payload: dict, manifest: dict) -> pd.DataFrame:
    if payload.get("schema_version") != manifest["feature_schema_version"]:
        raise ValueError("Unsupported feature schema")

    features = payload.get("features")
    if not isinstance(features, dict):
        raise ValueError("Missing features object")

    columns = manifest["feature_order"]
    missing = [name for name in columns if name not in features]
    extra = [name for name in features if name not in columns]
    if missing or extra:
        raise ValueError(f"Feature mismatch: missing={missing}, extra={extra}")

    row = [features[name] for name in columns]
    return pd.DataFrame([row], columns=columns)


with open("feature-manifest.json", encoding="utf-8") as file:
    manifest = json.load(file)

frame = to_model_frame(payload, manifest)
prediction = saved_preprocessing_pipeline.predict(frame)[0]
```

Important adapter rules:

- Load the saved preprocessing pipeline and trained model together when possible.
- Preserve categorical encoding, scaling, imputation, and column order from training.
- Do not manually one-hot encode categories differently in the Claude Code plugin.
- Do not rely on JSON object insertion order.
- Reject missing or extra model features.
- Reject categorical values outside the manifest unless the trained encoder explicitly supports unknown values.
- Reject negative counts, non-integers, `NaN`, and infinity.
- Record the feature-schema and model versions with every prediction.

The same named payload can be sent to a Python model service, passed to a local Python process over stdin, or adapted to an ONNX input. The Claude Code collector should not change when the model runtime changes.

Whatever runtime is chosen must fit inside the hook's 10-second timeout, including process start-up. A long-lived local prediction service is preferable to spawning a Python interpreter on every Enter.

## Claude Code Gate Integration

`claude-code/scripts/gate.mjs` currently calls `estimateTurn` unconditionally, before `decide`. That is cheap today and will not be once extraction and inference are involved, so the gate must be restructured to make the cheap bypasses run first:

1. Read and validate the hook input, and allow anything whose `hook_event_name` is not `UserPromptSubmit`.
2. Allow an empty prompt.
3. Handle TokenLens control commands (`tokenlens on|off|status`).
4. Allow when the gate is disabled.
5. Allow Claude Code slash commands such as `/clear` and `/model`.
6. Compute the prompt fingerprint and read pending state for `session_id`.
7. If the fingerprint matches pending state, allow immediately without extracting features again.
8. Build and validate the 14-feature payload for a new or edited prompt.
9. Pass the payload to the ML adapter or prediction client.
10. Allow when the prediction is below `thresholdUsd`.
11. Format the returned estimate using the existing TokenLens terminal message and store only the prompt fingerprint.
12. Fail open if feature extraction, model parsing, prediction, or state writing cannot produce a safe decision.

The hook's stdout must remain exactly one native Claude Code decision. Silence sends the prompt; a block is:

```json
{
  "decision": "block",
  "reason": "TokenLens paused this prompt. Nothing was sent, so nothing was billed. ... Press UP then ENTER to send it unchanged."
}
```

Never write diagnostics to stdout — anything that is not the decision JSON corrupts the contract. The existing fail-open path writes to stderr instead, and extraction failures must do the same.

Because a blocked `UserPromptSubmit` erases the composer, the confirming keystroke is Up-then-Enter rather than a second Enter. Feature extraction must therefore be keyed on the fingerprint, not on any assumption that the same prompt text is still in the input box.

Feature payloads should remain in memory by default. Do not write prompts or mentioned source code to disk.

## Validation and Tests

### Feature-Level Tests

- `output_format`: every category, precedence, conflicts, filenames that look like formats, and default.
- `task_type`: every category, multi-intent prompts, tie breaking, examples, and default.
- `detail_level`: concise, detailed, conflict, and standard default.
- `repo_id`: HTTPS/SSH remotes, missing origin, non-Git `cwd`, missing `cwd`, unknown repo, and privacy mapping.
- `model_id`: transcript model, dated model ids, aliases, empty transcript, unreadable transcript, and unknown value.
- `input_tokens`: empty, Unicode, multiline, and tokenizer golden cases.
- `attached_code_tokens`: duplicate mentions, mentions in fenced code, email-like text, directory mentions, binary files, missing files, paths outside `cwd`, symlinks, and size limit.
- `relevant_code_tokens`: mentioned files, bare-path references, ranges, overlap, deduplication, and no references.
- `task_word_count`: punctuation, Unicode, paths, `@` mentions, Markdown, inline code, and fenced code.
- `n_requirements`: prose requirements, lists, duplicate rule matches, questions, examples, and code blocks.
- `question_count`: multiple questions, `???`, URLs, inline code, fenced code, and no punctuation.
- `codebase_lines`: exact line definition, empty files, missing final newline, exclusions, and cache invalidation.
- `codebase_files`: exclusions, non-Git behavior, and limits.
- `n_files_attached`: duplicates, directories, image placeholders, invalid paths, and rejected files.

### Golden Feature Test

Create one fixture workspace containing:

- A Git origin mapped to a known `repo_id`.
- Known source files and physical line counts.
- One `@`-mentioned file.
- One prompt-referenced file range.
- A stub transcript whose last assistant message names a known model.
- A prompt with a known task type, output format, detail level, requirements, questions, words, and token count.

Assert the complete `features` object and its serialized schema. Inject the tokenizer, filesystem, Git results, transcript reader, clock, and manifest so the fixture is deterministic.

### ML Contract Test

For the same golden payload:

1. Validate it in Node against `ml-feature-payload.v1.schema.json`.
2. Parse it in the ML runtime.
3. Assert the DataFrame columns exactly equal `FEATURE_ORDER`.
4. Assert each row value matches the named payload value.
5. Run the saved preprocessing pipeline and model.
6. Assert inference returns the expected output type without feature-name warnings.

### Hook Integration Test

Spawn `claude-code/scripts/gate.mjs` exactly as Claude Code does — JSON on stdin, decision on stdout — and verify:

- A new prompt extracts one payload and requests one prediction.
- The unchanged confirmation does not extract or predict again.
- An edited prompt creates a new payload.
- Slash commands and TokenLens control commands do not extract features.
- A prompt containing `@` mentions produces the expected accepted file set from a real captured payload.
- Extraction or model failure fails open with a silent stdout.
- Stdout contains only the block decision JSON, or nothing.
- Pending state contains only a fingerprint.
- The whole path completes inside the hook's 10-second timeout on the fixture repository.

## Implementation Order

### Phase 1: Lock Training Compatibility

- Save the exact 14-column order in `feature-manifest.json`.
- Copy the trained categorical vocabularies and aliases.
- Record the tokenizer and version.
- Record repository inclusion and line-count rules.
- Record missing-value handling, including the pre-first-turn `model_id` fallback.
- Decide and record how the training-time attachment signal maps onto `@` mentions.
- Save the complete preprocessing pipeline with the model.

Deliverable: a manifest that completely defines every model input.

### Phase 2: Implement Pure Prompt Collectors

- Implement `output_format`, `task_type`, and `detail_level` classification.
- Implement `input_tokens`, `task_word_count`, `n_requirements`, and `question_count`.
- Add unit and golden tests for every rule.

Deliverable: seven deterministic prompt-derived features.

### Phase 3: Implement Workspace Collectors

- Implement `repo_id` from `cwd` and `model_id` from the transcript reader.
- Implement safe `@` mention parsing and path resolution.
- Implement `attached_code_tokens`, `relevant_code_tokens`, and `n_files_attached` from shared accepted file sets.
- Implement cached `codebase_lines` and `codebase_files`.
- Add containment, privacy, non-Git, and cache tests.

Deliverable: all 14 named features in one schema-valid payload.

### Phase 4: Implement the ML Adapter

- Load the feature manifest.
- Validate the payload and schema version.
- Convert named features into one row using the exact feature order.
- Load the saved preprocessing pipeline and model.
- Add cross-runtime and prediction contract tests.

Deliverable: a canonical TokenLens payload can be parsed and predicted by the ML model without manual column manipulation.

### Phase 5: Add to the Claude Code Gate

- Restructure `gate.mjs` so extraction runs only after the cheap bypasses, for new or edited prompts.
- Pass the feature payload to the prediction path.
- Keep the existing pending-fingerprint state and terminal formatting.
- Preserve fail-open behavior and add end-to-end tests.

Deliverable: the existing Claude Code TokenLens flow uses the trained model's 14 features.

## Acceptance Criteria

- The extractor returns exactly the 14 named model features.
- Feature order comes from the model manifest and exactly matches training.
- Every categorical value is normalized into the trained vocabulary.
- Every numeric value is a finite non-negative integer using the training-time definition.
- All three token features use the training tokenizer and version.
- `attached_code_tokens` and `n_files_attached` use the same deduplicated accepted mention set.
- `relevant_code_tokens` counts only code known before submission and never predicts future Claude Code file reads.
- `codebase_lines` and `codebase_files` use the same bounded, cached file set scoped to the `cwd` repository.
- `model_id` comes from the session transcript and falls back to the manifest's documented value before the first assistant turn.
- Carried context tokens are used for pricing only and never enter the feature payload.
- Absolute paths, raw prompts, and source contents are not included in the model feature payload.
- The named JSON payload is schema-valid before inference.
- The ML adapter ignores JSON property ordering and rejects missing, extra, or incompatible features.
- The saved training preprocessing pipeline receives one DataFrame row with the exact expected columns.
- A confirmed prompt whose fingerprint matches pending state bypasses extraction and prediction.
- Stdout carries only a block decision or nothing at all.
- Failures do not lock the user out of Claude Code.
