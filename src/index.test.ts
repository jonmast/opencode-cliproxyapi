import { afterEach, describe, expect, test } from "bun:test"
import plugin, { discoverCatalog, parseCachedCatalog } from "./index.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.CLIPROXY_BASE_URL
  delete process.env.CLIPROXY_API_KEY
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const requests: Request[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input as string, init))
    return handler(String(input), init)
  }
  return requests
}

function provider(catalog: Awaited<ReturnType<typeof discoverCatalog>>, id: string) {
  return catalog.find((p) => p.providerID === id)
}

describe("discoverCatalog", () => {
  test("maps the discovered catalog onto V2 provider and model shapes", async () => {
    const requests = stubFetch((url) => {
      if (url === "https://models.dev/api.json") return Response.json({})
      return Response.json({ data: [{ id: "gpt-5.6-terra" }, { id: "gemini-3.1-flash-image" }] })
    })

    const catalog = await discoverCatalog({
      baseURL: "http://cliproxy.test:8317",
      apiKey: "secret",
    })

    const modelRequest = requests.find((r) => r.url === "http://cliproxy.test:8317/v1/models")
    expect(modelRequest?.headers.get("authorization")).toBe("Bearer secret")

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      providerID: "cliproxyapi",
      providerName: "CLIProxyAPI",
      package: "aisdk:@ai-sdk/openai-compatible",
      baseURL: "http://cliproxy.test:8317/v1",
      apiKey: "secret",
    })

    expect(catalog[0].models).toEqual([
      {
        id: "gpt-5.6-terra",
        upstreamID: "gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        tools: true,
        input: ["text"],
        output: ["text"],
        limit: { context: 128_000, output: 8_192 },
        variants: [],
        reasoningField: "reasoning_content",
      },
      {
        id: "gemini-3.1-flash-image",
        upstreamID: "gemini-3.1-flash-image",
        name: "Gemini 3.1 Flash Image",
        tools: false,
        input: ["text", "image"],
        output: ["image"],
        limit: { context: 128_000, output: 8_192 },
        variants: [],
        reasoningField: "reasoning_content",
      },
    ])
  })

  test("uses the responses protocol package when requested", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({ data: [{ id: "chat-model" }] }),
    )

    const catalog = await discoverCatalog({
      baseURL: "http://cliproxy.test:8317",
      protocol: "responses",
    })

    expect(catalog[0].package).toBe("aisdk:@ai-sdk/openai")
  })

  test("routes Anthropic-compatible models to the Anthropic package", async () => {
    stubFetch((url) => {
      if (url === "https://models.dev/api.json") {
        return Response.json({
          acme: {
            npm: "@ai-sdk/anthropic",
            models: {
              "model-level-chat": { provider: { npm: "@ai-sdk/openai-compatible" } },
            },
          },
          chat: { npm: "@ai-sdk/openai-compatible", models: {} },
        })
      }
      return Response.json({
        data: [
          { id: "chat-model", owned_by: "chat" },
          { id: "messages-model", owned_by: "acme" },
          { id: "model-level-chat", owned_by: "acme" },
        ],
      })
    })

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })
    const packages = Object.fromEntries(catalog[0].models.map((m) => [m.id, m.package]))

    // Provider-level Anthropic default applies...
    expect(packages["messages-model"]).toBe("aisdk:@ai-sdk/anthropic")
    // ...but a model-level override wins over it.
    expect(packages["model-level-chat"]).toBeUndefined()
    expect(packages["chat-model"]).toBeUndefined()
  })

  test("applies metadata limits, names, and modalities when available", async () => {
    stubFetch((url) => {
      if (url === "https://models.dev/api.json") {
        return Response.json({
          acme: {
            npm: "@ai-sdk/openai-compatible",
            models: {
              "real-model": {
                name: "Real Model",
                tool_call: true,
                limit: { context: 1_000_000, output: 64_000 },
                modalities: { input: ["text", "image", "pdf"], output: ["text"] },
              },
            },
          },
        })
      }
      return Response.json({ data: [{ id: "real-model", owned_by: "acme" }] })
    })

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    expect(catalog[0].models[0]).toEqual({
      id: "real-model",
      upstreamID: "real-model",
      name: "Real Model",
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
      limit: { context: 1_000_000, output: 64_000 },
      variants: [],
      reasoningField: "reasoning_content",
    })
  })

  test("keeps discovered models when metadata is unavailable", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ data: [{ id: "chat-model", owned_by: "acme" }] }),
    )

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    expect(catalog[0].models).toHaveLength(1)
    expect(catalog[0].models[0]?.id).toBe("chat-model")
    expect(catalog[0].models[0]?.limit).toEqual({ context: 128_000, output: 8_192 })
  })

  test("skips metadata entirely when disabled", async () => {
    const requests = stubFetch(() => Response.json({ data: [{ id: "chat-model" }] }))

    await discoverCatalog({
      baseURL: "http://cliproxy.test:8317",
      modelMetadataURL: false,
    })

    expect(requests.some((r) => r.url === "https://models.dev/api.json")).toBe(false)
  })

  test("falls back to environment variables for the connection", async () => {
    process.env.CLIPROXY_BASE_URL = "http://from-env:8317"
    process.env.CLIPROXY_API_KEY = "env-key"
    const requests = stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({ data: [{ id: "chat-model" }] }),
    )

    const catalog = await discoverCatalog({})

    expect(catalog[0].baseURL).toBe("http://from-env:8317/v1")
    expect(catalog[0].apiKey).toBe("env-key")
    const modelRequest = requests.find((r) => r.url === "http://from-env:8317/v1/models")
    expect(modelRequest?.headers.get("authorization")).toBe("Bearer env-key")
  })

  test("propagates a CLIProxyAPI discovery failure", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({ error: "Missing API key" }, { status: 401 }),
    )

    await expect(discoverCatalog({ baseURL: "http://cliproxy.test:8317" })).rejects.toThrow(
      "HTTP 401",
    )
  })

  test("honors a custom provider id and name", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({ data: [{ id: "chat-model" }] }),
    )

    const catalog = await discoverCatalog({
      baseURL: "http://cliproxy.test:8317",
      providerID: "myproxy",
      providerName: "My CLIProxyAPI",
    })

    expect(catalog).toHaveLength(1)
    expect(catalog[0].providerID).toBe("myproxy")
    expect(catalog[0].providerName).toBe("My CLIProxyAPI")
  })

  test("groups models by the prefix before the first slash into separate providers", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({
            data: [
              { id: "opencode-go/hy3" },
              { id: "opencode-go/hy4" },
              { id: "anthropic/claude-sonnet-4-5" },
              { id: "gpt-5.6-terra" },
            ],
          }),
    )

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    expect(catalog.map((p) => p.providerID).sort()).toEqual([
      "cliproxyapi",
      "cliproxyapi-anthropic",
      "cliproxyapi-opencode-go",
    ])

    const go = provider(catalog, "cliproxyapi-opencode-go")!
    expect(go.providerName).toBe("Opencode Go (CLIProxyAPI)")
    expect(go.models).toEqual([
      { id: "hy3", upstreamID: "opencode-go/hy3", name: "Hy3", tools: true, input: ["text"], output: ["text"], limit: { context: 128_000, output: 8_192 }, variants: [], reasoningField: "reasoning_content" },
      { id: "hy4", upstreamID: "opencode-go/hy4", name: "Hy4", tools: true, input: ["text"], output: ["text"], limit: { context: 128_000, output: 8_192 }, variants: [], reasoningField: "reasoning_content" },
    ])

    const anthropic = provider(catalog, "cliproxyapi-anthropic")!
    expect(anthropic.providerName).toBe("Anthropic (CLIProxyAPI)")
    expect(anthropic.models[0]).toMatchObject({ id: "claude-sonnet-4-5", upstreamID: "anthropic/claude-sonnet-4-5" })

    const fallback = provider(catalog, "cliproxyapi")!
    expect(fallback.providerName).toBe("CLIProxyAPI")
    expect(fallback.models[0]).toMatchObject({ id: "gpt-5.6-terra", upstreamID: "gpt-5.6-terra" })
  })

  test("drops flat models that a prefixed model already covers", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({
            data: [
              { id: "anthropic/claude-sonnet-4-6" },
              { id: "claude-sonnet-4-6" },
              // Alias with no prefixed counterpart; must survive.
              { id: "claude-sonnet-4.6" },
              { id: "gpt-5.6-terra" },
            ],
          }),
    )

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    const anthropic = provider(catalog, "cliproxyapi-anthropic")!
    expect(anthropic.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6"])

    const fallback = provider(catalog, "cliproxyapi")!
    expect(fallback.models.map((m) => m.id).sort()).toEqual([
      "claude-sonnet-4.6",
      "gpt-5.6-terra",
    ])
  })

  test("removes the fallback provider when every flat model is shadowed", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({
            data: [{ id: "anthropic/claude-sonnet-4-6" }, { id: "claude-sonnet-4-6" }],
          }),
    )

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    expect(catalog.map((p) => p.providerID)).toEqual(["cliproxyapi-anthropic"])
  })

  test("keeps flat models untouched when grouping is disabled", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({
            data: [{ id: "anthropic/claude-sonnet-4-6" }, { id: "claude-sonnet-4-6" }],
          }),
    )

    const catalog = await discoverCatalog({
      baseURL: "http://cliproxy.test:8317",
      groupByPrefix: false,
    })

    const fallback = provider(catalog, "cliproxyapi")!
    expect(fallback.models.map((m) => m.id).sort()).toEqual([
      "anthropic/claude-sonnet-4-6",
      "claude-sonnet-4-6",
    ])
  })

  test("resolves metadata for prefixed model ids using the canonical short id", async () => {
    // Regression: "anthropic/claude-sonnet-4-6" must look up "claude-sonnet-4-6"
    // in models.dev (which keys by short id), not the full prefixed string.
    stubFetch((url) => {
      if (url === "https://models.dev/api.json") {
        return Response.json({
          anthropic: {
            npm: "@ai-sdk/anthropic",
            models: {
              "claude-sonnet-4-6": {
                name: "Claude Sonnet 4.6",
                tool_call: true,
                limit: { context: 200_000, output: 16_000 },
              },
              "claude-haiku-4-5": {
                name: "Claude Haiku 4.5",
                tool_call: true,
                limit: { context: 200_000, output: 16_000 },
              },
            },
          },
        })
      }
      return Response.json({
        data: [
          { id: "anthropic/claude-sonnet-4-6", owned_by: "anthropic" },
          // Flat-only model, so it survives deduplication.
          { id: "claude-haiku-4-5", owned_by: "anthropic" },
        ],
      })
    })

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    const anthropicGroup = provider(catalog, "cliproxyapi-anthropic")!
    const proxied = anthropicGroup.models.find((m) => m.id === "claude-sonnet-4-6")!
    // Prefixed model must get the real metadata name, not an auto-derived one.
    expect(proxied.name).toBe("Claude Sonnet 4.6")
    expect(proxied.limit).toEqual({ context: 200_000, output: 16_000 })
    expect(proxied.package).toBe("aisdk:@ai-sdk/anthropic")

    // A flat model under the default provider must also resolve correctly.
    const flat = provider(catalog, "cliproxyapi")!.models.find((m) => m.id === "claude-haiku-4-5")!
    expect(flat.name).toBe("Claude Haiku 4.5")
  })

  test("turns reasoning levels into per-protocol request overlays", async () => {
    stubFetch((url) => {
      if (url === "https://models.dev/api.json") {
        return Response.json({
          acme: { npm: "@ai-sdk/anthropic", models: {} },
          chat: { npm: "@ai-sdk/openai-compatible", models: {} },
        })
      }
      if (url.endsWith("?client_version=1")) {
        return Response.json({
          models: [
            {
              slug: "gpt-5.5",
              apply_patch_tool_type: "freeform",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
            },
            {
              slug: "claude-sonnet-4-6",
              supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }],
            },
            // Fabricated: a clone of the template's levels on a model the
            // server has no reasoning knowledge of.
            {
              slug: "gpt-4",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
            },
          ],
        })
      }
      return Response.json({
        data: [
          { id: "gpt-5.5", owned_by: "chat" },
          { id: "claude-sonnet-4-6", owned_by: "acme" },
          { id: "gpt-4", owned_by: "chat" },
        ],
      })
    })

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })
    const models = Object.fromEntries(catalog[0].models.map((m) => [m.id, m]))

    expect(models["gpt-5.5"]?.variants).toEqual([
      { id: "low", body: { reasoning_effort: "low" } },
      { id: "xhigh", body: { reasoning_effort: "xhigh" } },
    ])

    // Anthropic-routed models speak the Messages protocol upstream.
    expect(models["claude-sonnet-4-6"]?.variants).toEqual([
      { id: "high", body: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
      { id: "max", body: { thinking: { type: "adaptive" }, output_config: { effort: "max" } } },
    ])

    expect(models["gpt-4"]?.variants).toEqual([])
  })

  test("uses the Responses reasoning shape under the responses protocol", async () => {
    stubFetch((url) => {
      if (url === "https://models.dev/api.json") return Response.json({})
      if (url.endsWith("?client_version=1")) {
        return Response.json({
          models: [{ slug: "chat-model", supported_reasoning_levels: [{ effort: "high" }] }],
        })
      }
      return Response.json({ data: [{ id: "chat-model" }] })
    })

    const catalog = await discoverCatalog({
      baseURL: "http://cliproxy.test:8317",
      protocol: "responses",
    })

    expect(catalog[0].models[0]?.variants).toEqual([
      { id: "high", body: { reasoning: { effort: "high" } } },
    ])
    // The Responses protocol reports reasoning in its own right.
    expect(catalog[0].models[0]?.reasoningField).toBeUndefined()
  })

  test("keeps discovered models when the thinking catalog is unavailable", async () => {
    stubFetch((url) => {
      if (url === "https://models.dev/api.json") return Response.json({})
      if (url.endsWith("?client_version=1")) return new Response("nope", { status: 404 })
      return Response.json({ data: [{ id: "chat-model" }] })
    })

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })

    expect(catalog[0].models).toHaveLength(1)
    expect(catalog[0].models[0]?.variants).toEqual([])
  })

  test("skips the thinking catalog entirely when disabled", async () => {
    const requests = stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({ data: [{ id: "chat-model" }] }),
    )

    await discoverCatalog({ baseURL: "http://cliproxy.test:8317", thinkingLevels: false })

    expect(requests.some((r) => r.url.includes("client_version"))).toBe(false)
  })

  test("keeps the full id upstream when a group spans multiple slashes", async () => {
    stubFetch((url) =>
      url === "https://models.dev/api.json"
        ? Response.json({})
        : Response.json({ data: [{ id: "opencode-go/series/hy3" }] }),
    )

    const catalog = await discoverCatalog({ baseURL: "http://cliproxy.test:8317" })
    const go = provider(catalog, "cliproxyapi-opencode-go")!

    expect(go.models[0]).toMatchObject({
      id: "series/hy3",
      upstreamID: "opencode-go/series/hy3",
    })
  })
})

describe("parseCachedCatalog", () => {
  const validProvider = {
    providerID: "cliproxyapi",
    providerName: "CLIProxyAPI",
    package: "aisdk:@ai-sdk/openai-compatible",
    baseURL: "http://cliproxy.test:8317/v1",
    apiKey: "secret",
    models: [
      {
        id: "chat-model",
        upstreamID: "chat-model",
        name: "Chat Model",
        tools: true,
        input: ["text"],
        output: ["text"],
        limit: { context: 128_000, output: 8_192 },
        variants: [],
      },
    ],
  }

  test("returns the stored providers when the cache entry is well-formed", () => {
    const restored = parseCachedCatalog({ providers: [validProvider] })

    expect(restored).toEqual([validProvider])
  })

  test("returns an empty catalog when the cache entry is missing or malformed", () => {
    expect(parseCachedCatalog(undefined)).toEqual([])
    expect(parseCachedCatalog(null)).toEqual([])
    expect(parseCachedCatalog({})).toEqual([])
    expect(parseCachedCatalog({ providers: "chat-model" })).toEqual([])
    expect(parseCachedCatalog({ providers: [{ baseURL: "http://x" }] })).toEqual([])
  })

  test("drops malformed entries and providers without usable models", () => {
    const restored = parseCachedCatalog({
      providers: [
        validProvider,
        { providerID: "broken", models: [{ nope: true }] },
        { providerID: "empty", models: [] },
      ],
    })

    expect(restored).toEqual([validProvider])
  })
})

describe("plugin setup (stale-while-revalidate)", () => {
  const TEMPLATE = {
    slug: "gpt-5.5",
    apply_patch_tool_type: "freeform",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
  }
  const KIMI = (levels: string[]) => ({
    slug: "kimi-k3",
    supported_reasoning_levels: levels.map((effort) => ({ effort })),
  })

  /** Serves a one-model catalog; `thinking` controls the Codex client response. */
  function serve(thinking: () => Response) {
    return stubFetch((url) => {
      if (url === "https://models.dev/api.json") return Response.json({})
      if (url.includes("client_version=1")) return thinking()
      return Response.json({ data: [{ id: "kimi-k3" }] })
    })
  }

  /** Minimal OpenCode context recording what the plugin writes into the draft. */
  function makeCtx(cache?: unknown) {
    const storage = new Map<string, unknown>()
    if (cache !== undefined) storage.set("catalog", cache)

    let replay: ((draft: any) => void) | undefined
    let observed: Record<string, string[]> = {}

    const apply = (cb: (draft: any) => void) => {
      observed = {}
      cb({
        provider: {
          list: () => [],
          get: () => undefined,
          remove: () => {},
          update: (_id: string, update: (p: any) => void) => update({ settings: {} }),
        },
        model: {
          get: () => undefined,
          remove: () => {},
          default: { get: () => undefined, set: () => {} },
          update: (providerID: string, modelID: string, update: (m: any) => void) => {
            const model: any = { capabilities: {}, limit: {} }
            update(model)
            observed[`${providerID}/${modelID}`] = Array.isArray(model.variants)
              ? model.variants.map((v: any) => v.id)
              : []
          },
        },
      })
    }

    const ctx: any = {
      options: {
        baseURL: "http://cliproxy.test:8317",
        apiKey: "super-secret-key",
        groupByPrefix: false,
        refreshMs: 0,
      },
      integration: {
        transform: async (cb: (d: any) => void) =>
          cb({ update: (_id: string, u: (i: any) => void) => u({}), method: { update: () => {} } }),
        connection: { active: async () => undefined, resolve: async () => undefined },
      },
      storage: {
        get: async (k: string) => storage.get(k),
        set: async (k: string, v: unknown) => void storage.set(k, v),
      },
      catalog: {
        transform: async (cb: any) => {
          replay = cb
          apply(cb)
        },
        reload: async () => void (replay && apply(replay)),
      },
    }

    return { ctx, storage, variants: () => observed }
  }

  async function run(thinking: () => Response, cache?: unknown) {
    serve(thinking)
    const harness = makeCtx(cache)
    const cleanup = await plugin.setup(harness.ctx)
    // setup() revalidates fire-and-forget; let it settle.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))
    if (typeof cleanup === "function") await cleanup()
    return harness
  }

  const healthy = () => Response.json({ models: [TEMPLATE, KIMI(["low", "high"])] })

  test("discovers reasoning variants on a healthy server", async () => {
    const h = await run(healthy)
    expect(h.variants()["cliproxyapi/kimi-k3"]).toEqual(["low", "high"])
  })

  test("keeps cached variants when the thinking catalog request fails", async () => {
    const warm = (await run(healthy)).storage.get("catalog")

    const h = await run(() => new Response("boom", { status: 500 }), warm)

    expect(h.variants()["cliproxyapi/kimi-k3"]).toEqual(["low", "high"])
    expect(JSON.stringify(h.storage.get("catalog"))).toContain('"low"')
  })

  test("keeps cached variants when the thinking catalog omits a known model", async () => {
    const warm = (await run(healthy)).storage.get("catalog")

    // HTTP 200, but the model is briefly missing from the list.
    const h = await run(() => Response.json({ models: [TEMPLATE] }), warm)

    expect(h.variants()["cliproxyapi/kimi-k3"]).toEqual(["low", "high"])
  })

  test("still applies genuine changes to a model's reasoning levels", async () => {
    const warm = (await run(healthy)).storage.get("catalog")

    const h = await run(() => Response.json({ models: [TEMPLATE, KIMI(["low", "medium", "max"])] }), warm)

    expect(h.variants()["cliproxyapi/kimi-k3"]).toEqual(["low", "medium", "max"])
  })

  test("still registers models when the server has no Codex catalog", async () => {
    const h = await run(() => new Response("not found", { status: 404 }))

    expect(h.variants()["cliproxyapi/kimi-k3"]).toEqual([])
  })

  test("never writes the API key into the catalog cache", async () => {
    const h = await run(healthy)

    expect(JSON.stringify(h.storage.get("catalog"))).not.toContain("super-secret-key")
  })
})
