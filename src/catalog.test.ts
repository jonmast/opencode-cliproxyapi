import { describe, expect, test } from "bun:test"
import {
  discoverModelProtocols,
  discoverModels,
  discoverThinkingLevels,
  normalizeBaseURL,
  parseCatalog,
  parseModelProtocolCatalog,
  parseThinkingLevels,
} from "./catalog.js"

describe("normalizeBaseURL", () => {
  test.each([
    ["http://cliproxy.test:8317", "http://cliproxy.test:8317/v1"],
    ["http://cliproxy.test:8317/", "http://cliproxy.test:8317/v1"],
    ["http://cliproxy.test:8317/v1", "http://cliproxy.test:8317/v1"],
    ["https://example.com/proxy/", "https://example.com/proxy/v1"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeBaseURL(input)).toBe(expected)
  })
})

describe("parseCatalog", () => {
  test("returns unique valid models", () => {
    expect(
      parseCatalog({
        object: "list",
        data: [
          { id: "gpt-5.6-terra", object: "model", owned_by: "openai" },
          { id: "claude-sonnet-4-6", object: "model" },
          { id: "gpt-5.6-terra", object: "model" },
          { id: "" },
          null,
        ],
      }),
    ).toEqual([
      { id: "gpt-5.6-terra", ownedBy: "openai" },
      { id: "claude-sonnet-4-6" },
    ])
  })

  test("rejects malformed responses", () => {
    expect(() => parseCatalog({ data: {} })).toThrow("missing the data array")
    expect(() => parseCatalog({ data: [] })).toThrow("no usable models")
  })
})

describe("discoverModels", () => {
  test("uses bearer authentication", async () => {
    let authorization = ""
    const models = await discoverModels({
      baseURL: "http://cliproxy.test/v1",
      apiKey: "secret",
      timeoutMs: 1_000,
      fetcher: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return Response.json({ data: [{ id: "gemini-3.1-pro-low" }] })
      },
    })

    expect(authorization).toBe("Bearer secret")
    expect(models).toEqual([{ id: "gemini-3.1-pro-low" }])
  })

  test("reports an API error without hiding its useful detail", async () => {
    await expect(
      discoverModels({
        baseURL: "http://cliproxy.test/v1",
        timeoutMs: 1_000,
        fetcher: async () => Response.json({ error: "Missing API key" }, { status: 401 }),
      }),
    ).rejects.toThrow('HTTP 401: {"error":"Missing API key"}')
  })
})

describe("parseThinkingLevels", () => {
  function entry(slug: string, levels: string[], extra: Record<string, unknown> = {}) {
    return {
      slug,
      supported_reasoning_levels: levels.map((effort) => ({ effort, description: effort })),
      ...extra,
    }
  }

  // CLIProxyAPI deletes apply_patch_tool_type from entries it generates, so its
  // presence marks an entry whose levels come from a real Codex template.
  const template = { apply_patch_tool_type: "freeform" }

  test("keeps levels that differ from the cloned template", () => {
    expect(
      parseThinkingLevels({
        models: [
          entry("gpt-5.5", ["low", "medium", "high", "xhigh"], template),
          entry("claude-sonnet-4-6", ["low", "medium", "high", "max"]),
          entry("hy3", ["low", "medium", "high"]),
        ],
      }),
    ).toEqual({
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
      "claude-sonnet-4-6": ["low", "medium", "high", "max"],
      hy3: ["low", "medium", "high"],
    })
  })

  test("drops generated entries that merely echo the template", () => {
    const levels = parseThinkingLevels({
      models: [
        entry("gpt-5.5", ["low", "medium", "high", "xhigh"], template),
        // A non-reasoning model the server knows nothing about.
        entry("text-embedding-3-small", ["low", "medium", "high", "xhigh"]),
        // A budget-only Claude model, which has no discrete levels upstream.
        entry("claude-3-7-sonnet-20250219", ["low", "medium", "high", "xhigh"]),
      ],
    })

    expect(levels).toEqual({ "gpt-5.5": ["low", "medium", "high", "xhigh"] })
  })

  test("falls back to the known template levels when the template model is absent", () => {
    expect(
      parseThinkingLevels({
        models: [entry("gpt-4", ["low", "medium", "high", "xhigh"]), entry("kimi-k3", ["low", "high"])],
      }),
    ).toEqual({ "kimi-k3": ["low", "high"] })
  })

  test("tracks a template whose levels change upstream", () => {
    expect(
      parseThinkingLevels({
        models: [
          entry("gpt-5.5", ["low", "high"], template),
          entry("mystery-model", ["low", "high"]),
          entry("gpt-4", ["low", "medium", "high", "xhigh"]),
        ],
      }),
    ).toEqual({
      "gpt-5.5": ["low", "high"],
      // The stale fallback signature no longer strips anything by itself.
      "gpt-4": ["low", "medium", "high", "xhigh"],
    })
  })

  test("ignores entries without a slug or usable levels", () => {
    expect(
      parseThinkingLevels({
        models: [
          entry("", ["low", "high"]),
          { slug: "no-levels" },
          { slug: "empty-levels", supported_reasoning_levels: [] },
          { slug: "malformed", supported_reasoning_levels: [{ effort: 5 }, null] },
          null,
        ],
      }),
    ).toEqual({})
  })

  test("rejects a malformed catalog", () => {
    expect(() => parseThinkingLevels([])).toThrow("non-object thinking catalog")
    expect(() => parseThinkingLevels({ data: [] })).toThrow("missing the models array")
  })
})

describe("discoverThinkingLevels", () => {
  test("requests the Codex client catalog with bearer authentication", async () => {
    let requestedURL = ""
    let authorization = ""
    const levels = await discoverThinkingLevels({
      baseURL: "http://cliproxy.test/v1",
      apiKey: "secret",
      timeoutMs: 1_000,
      fetcher: async (input, init) => {
        requestedURL = String(input)
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return Response.json({
          models: [{ slug: "kimi-k3", supported_reasoning_levels: [{ effort: "max" }] }],
        })
      },
    })

    expect(requestedURL).toBe("http://cliproxy.test/v1/models?client_version=1")
    expect(authorization).toBe("Bearer secret")
    expect(levels).toEqual({ "kimi-k3": ["max"] })
  })

  test("reports an API error without hiding its useful detail", async () => {
    await expect(
      discoverThinkingLevels({
        baseURL: "http://cliproxy.test/v1",
        timeoutMs: 1_000,
        fetcher: async () => new Response("nope", { status: 404 }),
      }),
    ).rejects.toThrow("HTTP 404: nope")
  })
})

describe("parseModelProtocolCatalog", () => {
  test("indexes provider defaults and model-level SDK overrides", () => {
    expect(
      parseModelProtocolCatalog({
        acme: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "chat-model": {},
            "messages-model": {
              provider: {
                npm: "@ai-sdk/anthropic",
              },
            },
          },
        },
        malformed: {
          models: [],
        },
      }),
    ).toEqual({
      acme: {
        npm: "@ai-sdk/openai-compatible",
        models: {
          "messages-model": { npm: "@ai-sdk/anthropic" },
        },
      },
    })
  })

  test("captures name, tool_call, limits, and modalities", () => {
    expect(
      parseModelProtocolCatalog({
        acme: {
          models: {
            "real-model": {
              name: "Real Model",
              tool_call: true,
              limit: { context: 200000, output: 65536 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      }),
    ).toEqual({
      acme: {
        models: {
          "real-model": {
            name: "Real Model",
            toolCall: true,
            limit: { context: 200000, output: 65536 },
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
    })
  })

  test("ignores malformed limits and modalities", () => {
    expect(
      parseModelProtocolCatalog({
        acme: {
          models: {
            "bad-model": {
              name: "Bad Model",
              limit: { context: 0, output: -1 },
              modalities: { input: "text", output: [] },
            },
          },
        },
      }),
    ).toEqual({
      acme: {
        models: {
          "bad-model": { name: "Bad Model" },
        },
      },
    })
  })

  test("rejects a malformed catalog", () => {
    expect(() => parseModelProtocolCatalog([])).toThrow("non-object catalog")
  })
})

describe("discoverModelProtocols", () => {
  test("fetches protocol metadata from the configured URL", async () => {
    let requestedURL = ""
    const catalog = await discoverModelProtocols({
      url: "https://metadata.test/models.json",
      timeoutMs: 1_000,
      fetcher: async (input) => {
        requestedURL = String(input)
        return Response.json({
          acme: {
            models: {
              "messages-model": {
                provider: {
                  npm: "@ai-sdk/anthropic",
                },
              },
            },
          },
        })
      },
    })

    expect(requestedURL).toBe("https://metadata.test/models.json")
    expect(catalog).toEqual({
      acme: {
        models: {
          "messages-model": { npm: "@ai-sdk/anthropic" },
        },
      },
    })
  })
})
