# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-09-18

### Changed

- **Breaking:** Migrated to the provider/model registries OpenCode 2.0.4
  introduced in [#48901](https://github.com/sst/opencode/pull/48901), which
  removed the `catalog` plugin domain. Provider and model registration now runs
  through `ctx.provider.transform`, and revalidation reloads via
  `ctx.provider.reload()`. This release requires OpenCode 2.0.4 or newer; on
  2.0.0–2.0.3 it fails to load with
  `undefined is not an object (evaluating 'ctx.provider.transform')`. Stay on
  `0.2.x` for those versions.
- A startup with no cached catalog now waits for the first discovery before
  handing control back to OpenCode, capped by the new `coldWaitMs` option
  (default `3000`). Stale-while-revalidate previously returned immediately even
  with nothing to serve, so OpenCode activated the plugin against an empty
  catalog. Short-lived invocations such as `opencode run -m cliproxyapi-.../...`
  failed with `Model unavailable` and exited before the discovery that would
  have populated the cache ever completed, leaving every subsequent run equally
  cold. A warm cache still registers immediately and revalidates in the
  background, and discovery that outlives the cap still registers when it
  lands.

- The plugin now builds against the published `@opencode/plugin` package
  (OpenCode 2's own plugin package) instead of the `@opencode-ai/plugin`
  prerelease, so the V2 domains are properly typed.

## [0.2.0] - 2026-09-11

### Changed

- Model discovery now uses stale-while-revalidate: on startup the plugin
  registers the last discovered catalog immediately from its cache and
  refreshes it in the background, replaying the catalog transform only when the
  server's catalog changed. Cold starts no longer block the model picker on
  network discovery; the first-ever run simply populates the picker when
  discovery completes.
- The cached catalog is also revalidated on an interval, default every five
  minutes, so long-running sessions pick up server-side model changes. Set
  `"refreshMs": 0` to revalidate only at startup; concurrent polls are
  coalesced, so a slow discovery never stacks requests.
- A revalidation can no longer strip a model's reasoning variants. CLIProxyAPI's
  reasoning-level endpoint can fail outright or briefly serve an incomplete
  model list, and both read as "this model has no levels"; committing that
  reading removed variants from the picker and cached the loss, so it survived a
  restart. The previous catalog's variants are now carried forward instead.
  Genuine level changes still apply; a real removal needs the cache cleared.
- A missing Codex client catalog (`404`) is now treated as a genuine empty
  answer rather than an error, keeping it distinguishable from an endpoint that
  is merely broken.
- The cached catalog no longer stores the API key. Providers restored from cache
  authenticate through the integration until the next revalidation resolves the
  credential again.
- The npm package now ships the root `index.js` entrypoint wrapper required by
  OpenCode 2's plugin directory scan.
- This fork distributes as `@jonmast/opencode-cliproxyapi` on GitHub Packages
  (`npm.pkg.github.com`) and as a tarball attached to the GitHub release.

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

[Unreleased]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yourcasualdev/opencode-cliproxyapi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yourcasualdev/opencode-cliproxyapi/releases/tag/v0.1.0
