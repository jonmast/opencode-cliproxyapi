# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking:** Migrated to the OpenCode 2 plugin API. This release requires
  OpenCode 2 (`opencode2`) and no longer works with OpenCode 1. Use the
  `0.1.x` line for OpenCode 1.
- **Breaking:** The plugin entry moves from `plugin` to `plugins` and from the
  `["package", {options}]` tuple to `{"package": ..., "options": {...}}`.
- Provider and model registration now use the V2 catalog transform API and V2
  schema shapes: `npm` becomes `package` with an `aisdk:` prefix, `options`
  becomes `settings`, and `tool_call`/`modalities` become `capabilities`.
- User `providers.cliproxyapi` config is now applied by OpenCode after the
  plugin and takes precedence, replacing the plugin's own model merge.

### Added

- Model metadata now also supplies real context limits, display names, and
  modalities instead of only protocol routing.
- Discovered models that metadata does not describe fall back to a `128000`
  context and `8192` output limit, so they remain usable.
- Reasoning levels reported by CLIProxyAPI become selectable model variants
  (`provider/model#high`), written in the wire format of the protocol each
  model is reached over. Set `"thinkingLevels": false` to skip the extra
  discovery request.
- Models reached over the OpenAI chat protocol declare
  `compatibility.reasoningField: "reasoning_content"`, so CLIProxyAPI's
  reasoning output is rendered instead of dropped.

### Removed

- The V1 `attachment` and `reasoning` model hints, which OpenCode 2 ignores.
- Plugin logging via `client.app.log`, which the V2 plugin API does not expose.
  Discovery failures now surface through OpenCode's plugin load diagnostics.

## [0.1.2] - 2026-07-28

### Fixed

- Dynamically route models with Anthropic protocol metadata through
  `/v1/messages` instead of OpenAI-compatible chat completions, without
  hard-coding model IDs.
- Preserve discovered model protocol metadata when users customize individual
  model settings.

## [0.1.1] - 2026-07-25

### Changed

- Made persistent global OpenCode configuration the recommended setup flow.
- Moved temporary environment-variable setup to an optional alternative.
- Clarified API-key handling and troubleshooting.

## [0.1.0] - 2026-07-25

### Added

- Dynamic model discovery from CLIProxyAPI's `/v1/models` endpoint.
- OpenCode provider configuration for OpenAI-compatible chat completions.
- Custom server URL and API key support through environment variables or
  plugin options.
- Automatic model names and capability hints in OpenCode's model picker.
- Local plugin and npm package installation flows.

[Unreleased]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yourcasualdev/opencode-cliproxyapi/releases/tag/v0.1.0
