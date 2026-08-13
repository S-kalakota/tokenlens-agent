"""Capability gate for the native Claude Code composer integration.

Public Claude Code hooks are intentionally reported as incompatible.  A future
version-pinned adapter must explicitly advertise every required capability;
version strings or environment flags alone never grant send authority.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from dataclasses import asdict, dataclass
from typing import Final, Protocol

INTERCEPT_BEFORE_MODEL: Final = "intercept_before_model_request"
PRESERVE_COMPOSER: Final = "preserve_or_restore_composer"
RENDER_ASYNC_UI: Final = "render_async_controls"
REPLACE_COMPOSER: Final = "replace_composer_buffer"
OBSERVE_EDITS_AND_ENTER: Final = "observe_edits_and_enter"
RELEASE_CURRENT_SESSION_ONCE: Final = "release_into_current_session_once"

REQUIRED_CAPABILITIES: Final[tuple[str, ...]] = (
    INTERCEPT_BEFORE_MODEL,
    PRESERVE_COMPOSER,
    RENDER_ASYNC_UI,
    REPLACE_COMPOSER,
    OBSERVE_EDITS_AND_ENTER,
    RELEASE_CURRENT_SESSION_ONCE,
)


@dataclass(frozen=True)
class HostDescriptor:
    """Versioned capabilities reported by a concrete native host adapter."""

    host_name: str
    host_version: str
    adapter_name: str
    adapter_version: str
    api_revision: str | None
    capabilities: frozenset[str]


class CapabilityProvider(Protocol):
    def describe_host(self) -> HostDescriptor:
        """Return capabilities implemented by this adapter, not wished for."""


@dataclass(frozen=True)
class CompatibilityReport:
    compatible: bool
    host_name: str
    host_version: str
    adapter_name: str
    adapter_version: str
    api_revision: str | None
    required: tuple[str, ...]
    available: tuple[str, ...]
    missing: tuple[str, ...]
    reason: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


class UnsupportedNativeHostError(RuntimeError):
    """Raised before handler registration when the native contract is absent."""


def evaluate_host(descriptor: HostDescriptor) -> CompatibilityReport:
    """Evaluate an exact capability set; unknown capabilities grant nothing."""

    available = tuple(sorted(descriptor.capabilities))
    missing = tuple(
        capability
        for capability in REQUIRED_CAPABILITIES
        if capability not in descriptor.capabilities
    )
    compatible = descriptor.api_revision is not None and not missing
    if compatible:
        reason = "native composer host contract satisfied"
    elif descriptor.api_revision is None:
        reason = (
            "no supported native composer API revision was reported; public "
            "hooks and MCP do not implement the TokenLens pre-send contract"
        )
    else:
        reason = "native composer adapter is missing required capabilities"
    return CompatibilityReport(
        compatible=compatible,
        host_name=descriptor.host_name,
        host_version=descriptor.host_version,
        adapter_name=descriptor.adapter_name,
        adapter_version=descriptor.adapter_version,
        api_revision=descriptor.api_revision,
        required=REQUIRED_CAPABILITIES,
        available=available,
        missing=missing,
        reason=reason,
    )


def require_compatible(provider: CapabilityProvider) -> CompatibilityReport:
    """Fail before binding input handlers unless all six capabilities exist."""

    report = evaluate_host(provider.describe_host())
    if not report.compatible:
        missing = ", ".join(report.missing) or "supported API revision"
        raise UnsupportedNativeHostError(
            f"TokenLens native bridge is unavailable for "
            f"{report.host_name} {report.host_version}: {report.reason}. "
            f"Missing: {missing}."
        )
    return report


def _installed_claude_version() -> str:
    executable = shutil.which("claude")
    if executable is None:
        return "not-installed"
    try:
        result = subprocess.run(
            [executable, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    output = (result.stdout or result.stderr).strip()
    return output or "unknown"


def public_plugin_host() -> HostDescriptor:
    """Describe only what the public hook/plugin surface actually provides."""

    return HostDescriptor(
        host_name="Claude Code",
        host_version=_installed_claude_version(),
        adapter_name="public-plugin-hooks",
        adapter_version="1",
        api_revision=None,
        capabilities=frozenset(),
    )


def _hook_message(report: CompatibilityReport) -> dict[str, object]:
    missing = ", ".join(report.missing)
    display_mode = os.getenv("TOKENLENS_NATIVE_HOOK_APPROXIMATION", "").strip().lower()
    display_note = (
        " The opt-in display-only suggestion hook is enabled."
        if display_mode in {"1", "true", "yes", "on"}
        else ""
    )
    return {
        "continue": True,
        "suppressOutput": False,
        "systemMessage": (
            "TokenLens native pre-send bridge is inactive: the current Claude "
            f"Code plugin host lacks {missing}. No prompts are being gated by "
            f"the exact native bridge.{display_note}"
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check the TokenLens native Claude Code host contract."
    )
    parser.add_argument("--hook", action="store_true", help="emit SessionStart JSON")
    parser.add_argument("--json", action="store_true", help="emit report JSON")
    args = parser.parse_args(argv)

    report = evaluate_host(public_plugin_host())
    payload = _hook_message(report) if args.hook else report.to_dict()
    print(json.dumps(payload, sort_keys=True))
    # A SessionStart diagnostic must not break Claude Code startup. Direct
    # compatibility probes fail so installers/CI cannot ignore incompatibility.
    return 0 if args.hook or report.compatible else 1


if __name__ == "__main__":
    raise SystemExit(main())
