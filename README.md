# OpenCode CLIProxyAPI

[![CI](https://github.com/yourcasualdev/opencode-cliproxyapi/actions/workflows/ci.yml/badge.svg)](https://github.com/yourcasualdev/opencode-cliproxyapi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-cliproxyapi)](https://www.npmjs.com/package/opencode-cliproxyapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use every model exposed by [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
directly in [OpenCode](https://opencode.ai/).

The plugin discovers CLIProxyAPI's live `/v1/models` catalog whenever OpenCode
starts. The last discovered catalog is cached, so startups serve it immediately
(stale-while-revalidate), refresh it in the background, and keep revalidating it
on an interval (every five minutes by default), picking up any server-side
changes without blocking the `/models` picker on the network. Models whose ids carry a group prefix (the part before the first `/`,
e.g. `opencode-go/hy3`) are split into their own provider section in the
`/models` picker, named like **Opencode Go (CLIProxyAPI)**, so related models
stay grouped together. Unprefixed models remain under the default
**CLIProxyAPI** provider. Models that expose Anthropic-compatible endpoints are
automatically routed through the Anthropic SDK using live model metadata from
[models.dev](https://models.dev/), which also supplies real context limits,
display names, and modalities. The remaining discovered models continue to use
the provider's configured default protocol. No model IDs are hard-coded.

> **Requires OpenCode 2.** This version targets the V2 plugin API and runs on
> the `opencode2` binary. For OpenCode 1, use `opencode-cliproxyapi@0.1.x`.

## Quick start

You need OpenCode 2, a running CLIProxyAPI server, and one of its API keys.

### 1. Install

```bash
opencode2 plugin add opencode-cliproxyapi
```

### 2. Save your connection

Open your global OpenCode config:

```text
~/.config/opencode/opencode.json
```

The installer may have created `opencode.jsonc` instead. Either filename works.
Configure the plugin entry with your persistent server URL and API key:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-cliproxyapi",
      "options": {
        "baseURL": "http://your-server:8317",
        "apiKey": "your-cli-proxy-api-key"
      }
    }
  ]
}
```

The URL may include `/v1`, but it is not required. If `baseURL` is omitted, the
plugin uses `http://localhost:8317/v1`.

Keep this global config private because it contains your API key. Do not copy
the connection into a project's `opencode.json` or commit it to a repository.

### 3. Verify

```bash
opencode2 api get /api/model
```

You should see models reported by your server. With grouping enabled, prefixed
ids become their own provider sections:

```text
opencode-go/hy3
opencode-go/hy4
anthropic/claude-sonnet-4-6
cliproxyapi/gpt-5.6-terra
cliproxyapi/gemini-3.1-pro-low
```

Confirm the plugin itself loaded with `opencode2 api get /api/plugin`.

### 4. Select a model

Start OpenCode and run `/models`:

```bash
opencode2
```

Choose a grouped provider such as **Opencode Go (CLIProxyAPI)**, select a model,
and use OpenCode normally. Restart OpenCode whenever the model catalog on
CLIProxyAPI changes.

## Thinking levels

Models that CLIProxyAPI reports discrete reasoning levels for get one variant
per level, selectable as `provider/model#level` or with the `variant_cycle`
keybind:

```jsonc
{
  "model": "cliproxyapi/claude-sonnet-4-6#high"
}
```

Each variant carries the level in the format of the protocol its model is
reached over — `reasoning_effort` for chat, `reasoning.effort` for responses,
and adaptive `output_config.effort` for Anthropic-compatible models.
CLIProxyAPI converts that into whatever the upstream provider expects, so
budget-only models such as Claude 4.5 receive a token budget rather than a
level. Requests without a selected variant are unchanged, and CLIProxyAPI
rejects a level a model does not support rather than silently downgrading it.

Levels are read from CLIProxyAPI's Codex client catalog
(`/v1/models?client_version=1`). That endpoint describes models its registry
does not recognize by cloning a template entry, which makes non-reasoning
models appear to support reasoning; the plugin drops level lists that are
indistinguishable from the template, so models such as `gpt-4` and embedding
models correctly get no variants. The cost is that a model whose genuine levels
exactly match the template's is also skipped and simply has no variants.

That catalog is large — several megabytes, because every entry embeds its Codex
system prompt — and it is fetched under `discoveryTimeoutMs` like the other
discovery requests. If it fails or times out, models are still registered, just
without variants. Set `"thinkingLevels": false` to skip the request entirely.

## Configuration

The recommended configuration is the global plugin entry shown above:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-cliproxyapi",
      "options": {
        "baseURL": "http://your-server:8317",
        "apiKey": "your-cli-proxy-api-key",
        "providerName": "My CLIProxyAPI"
      }
    }
  ]
}
```

| Plugin option | Default | Purpose |
| --- | --- | --- |
| `baseURL` | `CLIPROXY_BASE_URL` or `http://localhost:8317/v1` | CLIProxyAPI URL |
| `apiKey` | `CLIPROXY_API_KEY` | CLIProxyAPI key |
| `providerID` | `cliproxyapi` | Provider ID for unprefixed models; prefixed models become their own provider with that prefix as the ID |
| `providerName` | `CLIProxyAPI` | Name displayed in the model picker; grouped providers append it as `Prefix (Name)` |
| `groupByPrefix` | `true` | Split models into one provider per id prefix (the part before `/`). Set to `false` to list every model under a single `providerID` provider. |
| `protocol` | `chat` | Default protocol: `chat` uses `/chat/completions`; `responses` uses `/responses`. Models marked as Anthropic-compatible by dynamic metadata override this per model. |
| `modelMetadataURL` | `https://models.dev/api.json` | Dynamic model metadata. Set to `false` to disable enrichment and use only the default protocol and fallback limits. |
| `refreshMs` | `300000` | How often the cached catalog is revalidated in the background (milliseconds). Set to `0` to revalidate only at startup. |
| `thinkingLevels` | `true` | Expose each model's reasoning levels as variants. Set to `false` to skip the extra discovery request. |
| `discoveryTimeoutMs` | `10000` | Startup model-discovery timeout |

If model metadata cannot be reached, the plugin keeps the
CLIProxyAPI-discovered models available with the configured default protocol.
Models that metadata does not describe fall back to a `128000` context and
`8192` output limit, which you can override per model (see below).

### Optional environment variables

Environment variables remain available for containers, CI, or users who prefer
not to place a key in the config:

```bash
export CLIPROXY_BASE_URL="http://your-server:8317"
export CLIPROXY_API_KEY="your-cli-proxy-api-key"
```

Put these lines in your shell profile if you want them to persist. Explicit
plugin options in `opencode.json` take precedence over environment variables.

Your own `providers.<id>` config is applied after the plugin and wins, so
individual models can be customized. With grouping enabled, the provider key is
the model's prefix (`opencode-go`), and the model key is the part after the
`/`. Prefixless models use `providerID`:

```json
{
  "providers": {
    "opencode-go": {
      "models": {
        "hy3": {
          "name": "HY3",
          "limit": {
            "context": 200000,
            "output": 65536
          }
        }
      }
    }
  }
}
```

## Troubleshooting

### `Missing API key`

Check that the global plugin entry contains a non-empty `apiKey`, then restart
OpenCode. If you chose environment variables instead, ensure
`CLIPROXY_API_KEY` is available to the process that starts OpenCode.

### No CLIProxyAPI models appear

First check the API directly:

```bash
curl -H "Authorization: Bearer your-cli-proxy-api-key" \
  "http://your-server:8317/v1/models"
```

Then restart the service and re-check:

```bash
opencode2 service restart
opencode2 api get /api/model
```

If discovery fails, the plugin fails to load and OpenCode records the reason.
Check the server log for `failed to load plugin`:

```bash
grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
```

### Environment configuration works in one terminal but not another

Move the connection to the recommended global OpenCode config, or add the
environment variables to your shell profile.

## Development

```bash
git clone https://github.com/yourcasualdev/opencode-cliproxyapi.git
cd opencode-cliproxyapi
bun install
bun run check
```

The repository's `opencode.json` loads the local build for integration testing:

```bash
bun run build
export CLIPROXY_BASE_URL="http://your-server:8317"
export CLIPROXY_API_KEY="your-cli-proxy-api-key"
opencode2 api get /api/model
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

[MIT](LICENSE)
