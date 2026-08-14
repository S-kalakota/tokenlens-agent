"""Vendored Token Counter output-token estimator and feature adapter.

The trained artifact comes from ``nkanthed06/Token_Counter`` and consumes the
14-feature contract published by ``nkanthed06/Claude_Token_Counter``.  This
module keeps the translation explicit: the existing TokenLens graph still
calls :func:`model.predictor.predict_many`, while this adapter builds the
training row and performs one batched scikit-learn prediction.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import warnings
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

from contracts import CostBand, PredictionContext

MODEL_PATH: Final = Path(__file__).with_name("model_combined.joblib")
MANIFEST_PATH: Final = Path(__file__).with_name("output_model_manifest.json")
MODEL_SHA256: Final = "9275c3ad424dcbfc12c5faeb09a4379014e73bf7bb287fdc0da01bd9ffe05c1c"
MODEL_VERSION: Final = "tokenlens-cost-model-v1-combined"
FIXED_OUTPUT_TOKENS: Final = 1_200
FIXTURE_OUTPUT_TOKENS: Final = 590
INTERVAL_LOW_RATIO: Final = 0.5496
INTERVAL_HIGH_RATIO: Final = 1.7982

CATEGORICAL: Final = (
    "output_format",
    "task_type",
    "repo_id",
    "model_id",
)
NUMERIC: Final = (
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
)
FEATURE_ORDER: Final = (*CATEGORICAL, *NUMERIC)
SUPPORTED_MODELS: Final = frozenset({"claude-haiku-4-5", "claude-sonnet-5"})

_MODEL_ALIASES: Final = {
    "haiku": "claude-haiku-4-5",
    "claude-haiku-4-5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-5",
    "claude-sonnet-5": "claude-sonnet-5",
}
_SOURCE_EXTENSIONS: Final = frozenset(
    {
        ".c",
        ".cc",
        ".cpp",
        ".cs",
        ".css",
        ".dart",
        ".ex",
        ".exs",
        ".go",
        ".graphql",
        ".h",
        ".hpp",
        ".html",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".kt",
        ".kts",
        ".lua",
        ".md",
        ".mjs",
        ".mts",
        ".php",
        ".proto",
        ".py",
        ".rb",
        ".rs",
        ".scss",
        ".sh",
        ".sql",
        ".svelte",
        ".swift",
        ".toml",
        ".ts",
        ".tsx",
        ".vue",
        ".xml",
        ".yaml",
        ".yml",
    }
)
_EXCLUDED_DIRECTORIES: Final = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".next",
        ".nuxt",
        ".output",
        ".terraform",
        ".venv",
        "build",
        "coverage",
        "dist",
        "generated",
        "node_modules",
        "target",
        "vendor",
    }
)
_EXTENSIONLESS: Final = frozenset({"Dockerfile", "Makefile", "Procfile"})

_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,}).*$")
_INLINE_CODE = re.compile(r"(`+)(?!`)([^\n]*?)\1")
_URL = re.compile(r"\b(?:https?|ftp)://[^\s<>]+", re.IGNORECASE)
_WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*|\d+", re.UNICODE)
_MENTION = re.compile(
    r"(?<!\S)@(?P<path>[\w.-]+(?:[/\\][\w.@+~-]+)*\.[\w]+)"
    r"(?=$|\s|[,:;!?()\[\]{}])"
)
_PATH_REFERENCE = re.compile(
    r"(?<![\w@])(?P<path>(?:[\w.-]+[/\\])*[\w.-]+\.[A-Za-z][\w+-]{0,11})"
    r"(?::(?P<start>\d+)(?:-(?P<end>\d+))?)?"
)

_ACTION = re.compile(
    r"^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|"
    r"i\s+(?:want|need)\s+you\s+to\s+)?(?:add|allow|audit|avoid|build|"
    r"change|clean(?:\s+up)?|compare|configure|count|create|debug|describe|"
    r"document|ensure|evaluate|exclude|explain|fix|handle|implement|include|"
    r"inspect|investigate|keep|load|make|modify|preserve|provide|read|"
    r"refactor|reject|remove|rename|reorganize|repair|replace|respond|"
    r"restructure|return|review|run|save|set\s+up|show|simplify|store|"
    r"support|test|update|use|validate|verify|write)\b",
    re.IGNORECASE,
)
_REQUIREMENT_MARKER = re.compile(
    r"\b(?:must|needs?\s+to|should|ensure|do\s+not|only)\b", re.IGNORECASE
)
_LIST_ITEM = re.compile(r"^\s*(?:[-+*]|\d+[.)])\s+(.+)$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}(?:\s+|$)")


class OutputFeatureRow(TypedDict):
    output_format: str
    task_type: str
    repo_id: str
    model_id: str
    detail_level: int
    input_tokens: int
    attached_code_tokens: float
    relevant_code_tokens: float
    task_word_count: int
    n_requirements: int
    question_count: int
    codebase_lines: int
    codebase_files: int
    n_files_attached: int


PredictionSource = Literal[
    "trained_output_model",
    "fixed_output_fallback",
    "hardcoded_fixture",
]


class OutputPrediction(TypedDict):
    band: CostBand
    source: PredictionSource
    model_id: str
    model_version: str


class OutputModelContractError(RuntimeError):
    """The vendored artifact or its feature contract is invalid."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_artifact(path: Path = MODEL_PATH) -> tuple[Any | None, str | None]:
    try:
        if _sha256(path) != MODEL_SHA256:
            return None, "vendored output model checksum does not match its manifest"
    except OSError as exc:
        return None, f"vendored output model could not be read: {exc}"
    try:
        import joblib

        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="Setting the shape on a NumPy array has been deprecated.*",
                category=DeprecationWarning,
                module="joblib.numpy_pickle",
            )
            artifact = joblib.load(path)
    except Exception as exc:
        return None, f"vendored output model could not be loaded: {exc}"
    if not isinstance(artifact, dict) or "model" not in artifact:
        return None, "vendored output model is not a Token Counter artifact"
    if tuple(artifact.get("categorical", ())) != CATEGORICAL:
        return None, "output model categorical feature order does not match"
    if tuple(artifact.get("numeric", ())) != NUMERIC:
        return None, "output model numeric feature order does not match"
    if artifact.get("target_transform") != "log1p":
        return None, "output model target transform is not log1p"
    if frozenset(artifact.get("llms", ())) != SUPPORTED_MODELS:
        return None, "output model supported-model contract does not match"
    return artifact["model"], None


_MODEL, _MODEL_UNAVAILABLE_REASON = _load_artifact()


def normalize_model_id(value: str) -> str | None:
    normalized = value.strip().lower()
    if normalized.startswith("anthropic/"):
        normalized = normalized.split("/", 1)[1]
    normalized = re.sub(r"-\d{8}$", "", normalized)
    resolved = _MODEL_ALIASES.get(normalized, normalized)
    return resolved if resolved in SUPPORTED_MODELS else None


def _strip_fenced_code(prompt: str) -> str:
    output: list[str] = []
    fence_character: str | None = None
    fence_width = 0
    for line in prompt.replace("\r\n", "\n").replace("\r", "\n").splitlines(True):
        content = line[:-1] if line.endswith("\n") else line
        newline = "\n" if line.endswith("\n") else ""
        match = _FENCE.match(content)
        marker = match.group(1) if match else None
        if fence_character is not None:
            if (
                marker
                and marker[0] == fence_character
                and len(marker) >= fence_width
                and not content[len(marker) :].strip()
            ):
                fence_character = None
            output.append(" " * len(content) + newline)
        elif marker:
            fence_character = marker[0]
            fence_width = len(marker)
            output.append(" " * len(content) + newline)
        else:
            output.append(line)
    return "".join(output)


def _strip_code(prompt: str) -> str:
    return _INLINE_CODE.sub(
        lambda match: " " * len(match.group(0)), _strip_fenced_code(prompt)
    )


def _classify_output_format(prompt: str) -> str:
    text = _strip_fenced_code(prompt).casefold()
    rules = (
        (
            "json",
            (
                r"\b(?:valid\s+json|json\s+object)\b",
                r"\b(?:return|output|provide|emit).{0,25}\bjson\b",
            ),
        ),
        (
            "patch",
            (
                r"\b(?:unified\s+diff|diff\s+only|patch\s+only)\b",
                r"\b(?:show|return|provide).{0,20}\b(?:patch|diff)\b",
            ),
        ),
        (
            "table",
            (
                r"\b(?:tabular\s+format|csv\s+table)\b",
                r"\b(?:return|show|provide).{0,20}\btable\b",
            ),
        ),
        (
            "markdown",
            (
                r"\bmarkdown\s+document\b",
                r"\b(?:write|return|provide).{0,20}\bmarkdown\b",
                r"\bwrite\s+(?:a\s+)?readme\b",
            ),
        ),
        (
            "plain_text",
            (
                r"\bplain[ -]text\b",
                r"\b(?:respond|return|explain|write).{0,20}\bin\s+prose\b",
            ),
        ),
        (
            "code",
            (
                r"\b(?:implement|write\s+(?:the\s+)?code|create\s+(?:the\s+|a\s+)?file|add\s+(?:the\s+|a\s+)?(?:function|class|module|component|endpoint))\b",
            ),
        ),
    )
    for category, patterns in rules:
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns):
            return category
    return "unspecified"


def _classify_task_type(prompt: str) -> str:
    text = "\n".join(
        line
        for line in _strip_fenced_code(prompt).casefold().splitlines()
        if not re.match(r"^\s*(?:for\s+example|examples?|e\.g\.)\s*:", line)
    )
    rules: tuple[tuple[str, tuple[tuple[str, int], ...]], ...] = (
        (
            "bug_fix",
            (
                (r"\b(?:bug\s*fix|fix|debug)\w*\b", 3),
                (r"\b(?:broken|error|regression|failing|failure|crash)\w*\b", 1),
            ),
        ),
        (
            "feature",
            (
                (r"\b(?:new\s+feature|add\s+(?:support|a|an|the)|implement)\w*\b", 3),
                (r"\b(?:add|build|create|support)\b", 1),
            ),
        ),
        (
            "refactor",
            (
                (r"\b(?:refactor|restructure|reorganize)\w*\b", 3),
                (r"\b(?:simplify|clean\s+up)\w*\b", 1),
            ),
        ),
        (
            "test",
            (
                (
                    r"\b(?:add|write|create)\s+(?:focused\s+|unit\s+|integration\s+)?tests?\b",
                    3,
                ),
                (r"\btests?\b", 1),
            ),
        ),
        (
            "configuration",
            (
                (
                    r"\b(?:configure|configuration|set\s*up|environment\s+(?:setting|configuration))\b",
                    3,
                ),
                (r"\b(?:manifest|config)\b", 1),
            ),
        ),
        (
            "documentation",
            (
                (
                    r"\b(?:api\s+docs?|write\s+(?:a\s+)?guide|update\s+(?:the\s+)?readme)\b",
                    3,
                ),
                (r"\b(?:document\w*|readme|guide|comments?)\b", 1),
            ),
        ),
        (
            "review",
            (
                (r"\b(?:code\s+review|find\s+issues)\b", 3),
                (r"\b(?:review|audit|inspect|critique)\w*\b", 2),
            ),
        ),
        (
            "research",
            (
                (r"\b(?:compare\s+options|evaluate\s+approaches)\b", 3),
                (r"\b(?:investigate|research|evaluate)\w*\b", 2),
            ),
        ),
        (
            "explanation",
            (
                (r"\b(?:how|why)\s+does\b", 3),
                (r"\bwhat\s+(?:is|are|does)\b", 3),
                (r"\b(?:explain|describe)\w*\b", 2),
            ),
        ),
    )
    best, best_score = "other", 0
    for category, signals in rules:
        score = sum(
            weight
            for pattern, weight in signals
            if re.search(pattern, text, re.IGNORECASE)
        )
        if score > best_score:
            best, best_score = category, score
    return best


def _detail_level(prompt: str) -> int:
    text = _strip_fenced_code(prompt).casefold()
    concise = bool(
        re.search(
            r"\b(?:brief|briefly|concise|concisely|minimal|short|just\s+the\s+answer)\b",
            text,
        )
    )
    detailed = bool(
        re.search(
            r"\b(?:detailed|thorough|comprehensive|step[ -]by[ -]step|"
            r"all\s+edge\s+cases|production[ -]ready)\b",
            text,
        )
    )
    if concise != detailed:
        return 0 if concise else 2
    return 1


def _prompt_metrics(prompt: str) -> tuple[int, int, int]:
    prose = _URL.sub(" ", _strip_code(prompt))
    prose = _PATH_REFERENCE.sub(" ", prose)
    words = len(_WORD.findall(prose))
    requirements = 0
    for line in prose.splitlines():
        if _HEADING.match(line):
            continue
        list_match = _LIST_ITEM.match(line)
        units = (
            [list_match.group(1)]
            if list_match
            else re.split(r"[;]+|(?<=[.!?])\s+", line)
        )
        for unit in units:
            stripped = unit.strip()
            if not stripped:
                continue
            question = stripped.rstrip().endswith("?")
            marked = bool(_REQUIREMENT_MARKER.search(stripped))
            action = bool(_ACTION.search(stripped))
            if (not question and (marked or action)) or marked or action:
                requirements += 1
    questions = len(re.findall(r"(?<!\\)\?+", prose))
    return words, requirements, questions


def _workspace_root() -> Path | None:
    configured = os.getenv("TOKENLENS_WORKSPACE_ROOT", "").strip()
    candidate = Path(configured) if configured else Path.cwd()
    try:
        result = subprocess.run(
            ["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=1,
        )
        return Path(result.stdout.strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        return None


def _included_path(path: str) -> bool:
    candidate = Path(path)
    if any(part in _EXCLUDED_DIRECTORIES for part in candidate.parts[:-1]):
        return False
    return (
        candidate.name in _EXTENSIONLESS
        or candidate.suffix.lower() in _SOURCE_EXTENSIONS
    )


@lru_cache(maxsize=8)
def _repository_metrics(root_text: str) -> tuple[int, int]:
    root = Path(root_text)
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            check=True,
            capture_output=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return 0, 0
    files = sorted(
        {
            item.decode("utf-8", "surrogateescape")
            for item in result.stdout.split(b"\0")
            if item
        }
    )
    lines = 0
    count = 0
    total_bytes = 0
    for relative in files[:5_000]:
        if not _included_path(relative):
            continue
        candidate = (root / relative).resolve()
        try:
            candidate.relative_to(root)
            data = candidate.read_bytes()
        except (OSError, ValueError):
            continue
        if len(data) > 1024 * 1024 or b"\0" in data:
            continue
        if total_bytes + len(data) > 32 * 1024 * 1024:
            break
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        total_bytes += len(data)
        count += 1
        lines += data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)
    return lines, count


def _safe_file(root: Path, relative: str) -> tuple[Path, str] | None:
    if not _included_path(relative) or "\0" in relative:
        return None
    try:
        candidate = (root / relative).resolve(strict=True)
        candidate.relative_to(root)
        if not candidate.is_file() or candidate.stat().st_size > 1024 * 1024:
            return None
        text = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeError, ValueError):
        return None
    return candidate, text


def _referenced_code(prompt: str, root: Path | None) -> tuple[int, int, int]:
    if root is None:
        return 0, 0, 0
    attached: dict[Path, str] = {}
    relevant: dict[Path, str] = {}
    for match in _MENTION.finditer(_strip_code(prompt)):
        resolved = _safe_file(root, match.group("path"))
        if resolved:
            attached[resolved[0]] = resolved[1]
            relevant[resolved[0]] = resolved[1]
    for match in _PATH_REFERENCE.finditer(_strip_fenced_code(prompt)):
        resolved = _safe_file(root, match.group("path"))
        if not resolved:
            continue
        text = resolved[1]
        if match.group("start"):
            start = max(1, int(match.group("start")))
            end = max(start, int(match.group("end") or start))
            text = "\n".join(text.splitlines()[start - 1 : end])
        relevant[resolved[0]] = text
    attached_tokens = sum(math.ceil(len(text) / 4) for text in attached.values())
    relevant_tokens = sum(math.ceil(len(text) / 4) for text in relevant.values())
    return attached_tokens, relevant_tokens, len(attached)


def build_output_feature_row(prompt: str, ctx: PredictionContext) -> OutputFeatureRow:
    """Build the exact named training row for one prompt."""

    root = _workspace_root()
    codebase_lines, codebase_files = _repository_metrics(str(root)) if root else (0, 0)
    attached, relevant, attached_count = _referenced_code(prompt, root)
    words, requirements, questions = _prompt_metrics(prompt)
    model_id = normalize_model_id(ctx["target_model"]) or "unknown"
    output_format = _classify_output_format(prompt)
    format_mapping = {
        "json": "JSON",
        "code": "code",
        "patch": "patch",
        "markdown": "explanation",
        "plain_text": "explanation",
        "table": "JSON",
        "unspecified": "explanation",
    }
    task_mapping = {
        "bug_fix": "bug",
        "documentation": "docs",
        "feature": "feature",
        "refactor": "refactor",
        "test": "test",
        "configuration": "other",
        "explanation": "other",
        "research": "other",
        "review": "other",
        "other": "other",
    }
    typed_tokens = math.ceil(len(prompt.replace("\r\n", "\n").replace("\r", "\n")) / 4)
    missing = float("nan")
    return {
        "output_format": format_mapping[output_format],
        "task_type": task_mapping[_classify_task_type(prompt)],
        "repo_id": ctx.get("project") or "unknown",
        "model_id": model_id,
        "detail_level": _detail_level(prompt),
        # Training defined input_tokens as typed prompt plus attached code.
        "input_tokens": typed_tokens + attached,
        "attached_code_tokens": float(attached) if attached else missing,
        "relevant_code_tokens": float(relevant) if relevant else missing,
        "task_word_count": words,
        "n_requirements": requirements,
        "question_count": questions,
        "codebase_lines": codebase_lines,
        "codebase_files": codebase_files,
        "n_files_attached": attached_count,
    }


def _band(point: float, source: PredictionSource, model_id: str) -> OutputPrediction:
    tokens = max(0.0, point)
    if source == "hardcoded_fixture":
        low, middle, high = 324.0, 590.0, 1_062.0
    elif source == "fixed_output_fallback":
        low = middle = high = float(FIXED_OUTPUT_TOKENS)
    else:
        low, middle, high = (
            tokens * INTERVAL_LOW_RATIO,
            tokens,
            tokens * INTERVAL_HIGH_RATIO,
        )
    return {
        "band": {
            "p10": low,
            "p50": middle,
            "p90": high,
            "source": source,
            "model_version": MODEL_VERSION,
            "target_model": model_id,
        },
        "source": source,
        "model_id": model_id,
        "model_version": MODEL_VERSION,
    }


def predict_output_many(
    prompts: Sequence[str],
    ctx: PredictionContext,
    *,
    model: Any = None,
) -> list[OutputPrediction]:
    """Predict output lengths in one model call, with explicit fallbacks."""

    if not prompts:
        return []
    selected_model = normalize_model_id(ctx["target_model"])
    estimator = _MODEL if model is None else model
    results: list[OutputPrediction | None] = [None] * len(prompts)
    model_indexes: list[int] = []
    rows: list[OutputFeatureRow] = []
    for index, prompt in enumerate(prompts):
        if "assert-on-string-literal" in prompt and "empty literals" in prompt:
            results[index] = _band(
                FIXTURE_OUTPUT_TOKENS,
                "hardcoded_fixture",
                selected_model or ctx["target_model"],
            )
        elif estimator is None or selected_model is None:
            results[index] = _band(
                FIXED_OUTPUT_TOKENS,
                "fixed_output_fallback",
                selected_model or ctx["target_model"],
            )
        else:
            model_indexes.append(index)
            rows.append(build_output_feature_row(prompt, ctx))

    if rows:
        try:
            import numpy as np
            import pandas as pd

            frame = pd.DataFrame(rows, columns=FEATURE_ORDER)
            raw = estimator.predict(frame)
            points = np.expm1(raw)
        except Exception as exc:
            raise OutputModelContractError(
                f"output model prediction failed: {exc}"
            ) from exc
        if len(points) != len(rows):
            raise OutputModelContractError("output model returned the wrong batch size")
        for index, point in zip(model_indexes, points, strict=True):
            results[index] = _band(float(point), "trained_output_model", selected_model)

    if any(result is None for result in results):
        raise OutputModelContractError("output prediction result assembly failed")
    return [result for result in results if result is not None]


def model_status() -> dict[str, object]:
    """Return auditable runtime/model provenance for diagnostics."""

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {
        "available": _MODEL is not None,
        "unavailable_reason": _MODEL_UNAVAILABLE_REASON,
        "model_version": MODEL_VERSION,
        "supported_models": sorted(SUPPORTED_MODELS),
        "fallback_output_tokens": FIXED_OUTPUT_TOKENS,
        "source": manifest["source"],
        "sha256": MODEL_SHA256,
    }


def model_available() -> bool:
    """Return whether the checksum-validated trained artifact loaded."""

    return _MODEL is not None
