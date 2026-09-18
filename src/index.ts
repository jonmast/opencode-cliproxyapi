import { Plugin } from "@opencode/plugin"
import {
  discoverModelProtocols,
  discoverModels,
  discoverThinkingLevels,
  normalizeBaseURL,
  type CatalogModel,
  type ModelMetadata,
  type ModelProtocolCatalog,
  type ThinkingLevelCatalog,
} from "./catalog.js"

const DEFAULT_BASE_URL = "http://localhost:8317/v1"
const DEFAULT_PROVIDER_ID = "cliproxyapi"
/**
 * Integration the generated providers authenticate through. Registering one
 * lets OpenCode own the credential (`opencode auth login`) instead of the key
 * living in plaintext plugin options.
 */
const INTEGRATION_ID = "cliproxyapi"
const DEFAULT_PROVIDER_NAME = "CLIProxyAPI"
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000
/** How often the cached catalog is revalidated in the background. */
const DEFAULT_REFRESH_MS = 300_000
/**
 * How long a cache-less startup waits for the first discovery before handing
 * control back to OpenCode. Long enough for a healthy local server, short
 * enough that an unreachable one is not felt as a hang.
 */
const DEFAULT_COLD_WAIT_MS = 3_000
const DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json"
const ANTHROPIC_NPM = "@ai-sdk/anthropic"

/** Plugin storage key holding the last successfully discovered catalog. */
const CATALOG_CACHE_KEY = "catalog"

/**
 * Field CLIProxyAPI streams reasoning text in when it speaks the OpenAI chat
 * protocol. Anthropic and Responses traffic carries reasoning natively.
 */
const CHAT_REASONING_FIELD = "reasoning_content"

/**
 * Context and output limits used when no metadata source knows the model.
 * OpenCode defaults new models to zero, which disables context accounting, so
 * a conservative non-zero floor keeps arbitrary proxied models usable.
 */
const FALLBACK_LIMIT = { context: 128_000, output: 8_192 }

export type ConnectorOptions = {
  baseURL?: string
  apiKey?: string
  providerID?: string
  providerName?: string
  protocol?: "chat" | "responses"
  modelMetadataURL?: string | false
  discoveryTimeoutMs?: number
  /**
   * Interval in milliseconds between background revalidations of the cached
   * catalog. `0` disables polling; startup revalidation always runs.
   */
  refreshMs?: number
  /**
   * How long a startup with no cached catalog waits for the first discovery
   * before returning. `0` never waits, restoring fire-and-forget startup.
   */
  coldWaitMs?: number
  /** Split models into one provider per id prefix (the part before `/`). */
  groupByPrefix?: boolean
  /** Expose each model's reasoning levels as selectable variants. */
  thinkingLevels?: boolean
}

export type DiscoveredProvider = {
  providerID: string
  providerName: string
  package: string
  baseURL: string
  apiKey?: string
  models: DiscoveredModel[]
}

export type DiscoveredModel = {
  id: string
  upstreamID: string
  name: string
  package?: string
  tools: boolean
  input: string[]
  output: string[]
  limit: { context: number; output: number }
  /** One request overlay per reasoning level the model accepts. */
  variants: ModelVariant[]
  /** Assistant-message field carrying streamed reasoning, when non-standard. */
  reasoningField?: string
  /**
   * Whether model metadata described this model on the discovery that produced
   * it. An unenriched model is carrying defaults rather than known values, so
   * a previously enriched copy is the better answer.
   */
  enriched: boolean
}

export type ModelVariant = {
  id: string
  body: Record<string, unknown>
}

export default Plugin.define({
  id: "opencode-cliproxyapi",
  setup: async (ctx) => {
    const configured = readOptions(ctx.options)

    // Register the integration before anything else. Discovery below may fail
    // when no credential exists yet; the integration must still be present so
    // `opencode auth login` has something to connect to.
    await ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = configured.providerName ?? DEFAULT_PROVIDER_NAME
      })
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          type: "key",
          label: "API key",
          form: [
            {
              type: "string",
              key: "baseURL",
              title: "Base URL",
              description: "CLIProxyAPI endpoint, e.g. http://localhost:8317/v1",
              placeholder: DEFAULT_BASE_URL,
              required: false,
            },
          ],
        },
      })
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: ["CLIPROXY_API_KEY"] },
      })
    })

    // Stale-while-revalidate: serve the last discovered catalog immediately so
    // the model picker is populated without waiting on the network, then
    // refresh in the background and replay the transform when it changes.
    // A cold start with no cache behaves as before, just without blocking
    // setup on discovery.
    let providers = parseCachedCatalog(await ctx.storage.get(CATALOG_CACHE_KEY))

    // Provider transforms own provider settings and their model definitions.
    // `ctx.model` edits the already-resolved candidate set instead, which
    // cannot introduce a provider, so registration belongs here.
    await ctx.provider.transform((draft) => {
      for (const provider of providers) {

        draft.update(provider.providerID, (p) => {
          p.name = provider.providerName
          p.package = provider.package
          // Point at the integration so OpenCode surfaces this provider under
          // the same credential, and only activates it once one resolves.
          p.integrationID = INTEGRATION_ID as unknown as typeof p.integrationID
          p.settings = {
            ...p.settings,
            baseURL: provider.baseURL,
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
          }
        })

        for (const model of provider.models) {
          draft.models.update(provider.providerID, model.id, (draftModel) => {
            // The catalog key is the group-stripped id, so the full CLIProxyAPI
            // id must be sent upstream via modelID to keep routing intact.
            draftModel.modelID = model.upstreamID as unknown as typeof draftModel.modelID
            draftModel.name = model.name
            draftModel.capabilities.tools = model.tools
            draftModel.capabilities.input = [...model.input]
            draftModel.capabilities.output = [...model.output]
            draftModel.limit.context = model.limit.context
            draftModel.limit.output = model.limit.output
            if (model.package) draftModel.package = model.package
            if (model.reasoningField) {
              draftModel.compatibility = {
                ...draftModel.compatibility,
                reasoningField: model.reasoningField,
              }
            }
            if (model.variants.length > 0) {
              draftModel.variants = model.variants.map((variant) => ({
                id: variant.id,
                body: { ...variant.body },
              })) as unknown as typeof draftModel.variants
            }
          })
        }
      }
    })

    // oc-go-backed models are rejected unless the request carries the calling
    // session's id. It changes per request, so a static `p.settings` header
    // cannot supply it — only a per-request hook can. The hook closes over
    // `providers`, so a background revalidation that adds providers is covered
    // without re-registering.
    const report = diagnostics()

    // One revalidation at a time: a slow poll must not stack behind a hung
    // server, or each interval adds another request to the pile.
    let inFlight = false
    const revalidate = async () => {
      if (inFlight) return
      inFlight = true
      try {
        await doRevalidate()
      } finally {
        inFlight = false
      }
    }

    const doRevalidate = async () => {
      // A missing or unreachable server must not take the plugin down with it,
      // otherwise the integration disappears and the key can never be entered.
      const options = { ...configured, ...(await readCredential(ctx, configured)) }
      const fresh = await discoverCatalog(options).catch((error: unknown) => {
        report.failed(error instanceof Error ? error.message : String(error))
        return undefined
      })
      if (!fresh || fresh.length === 0) {
        // Discovery failed or found nothing: keep serving the cached catalog.
        if (fresh) report.failed("the server returned no models")
        return
      }
      report.recovered()

      const merged = preserveVariants(preserveMetadata(fresh, providers), providers)
      const unchanged = JSON.stringify(merged) === JSON.stringify(providers)
      if (unchanged) {
        // Persist anyway so a failed earlier write recovers on the next run.
        await saveCacheIn(ctx, merged)
        return
      }

      providers = merged
      await saveCacheIn(ctx, merged)
      // Reload replays the registered transform against the updated capture.
      await ctx.provider.reload()
    }

    // A warm cache is already registered, so revalidation runs fire-and-forget
    // and a failure just leaves the cached catalog in place.
    //
    // A cold cache has nothing to serve, so there is no staleness to trade
    // latency against: setup holds open until the first discovery lands.
    // Otherwise OpenCode treats the plugin as activated with an empty catalog,
    // and a one-shot `opencode run -m cliproxyapi-.../...` resolves its model
    // during that window and fails outright. The cap bounds the wait so an
    // unreachable server cannot stall startup for the full discovery timeout;
    // discovery keeps running either way and registers through `reload()`
    // whenever it completes.
    const first = revalidate().catch(() => {})
    if (providers.length === 0) {
      const cap = deadline(configured.coldWaitMs ?? DEFAULT_COLD_WAIT_MS)
      await Promise.race([first, cap.promise])
      cap.cancel()
    }

    const refreshMs = configured.refreshMs ?? DEFAULT_REFRESH_MS
    if (refreshMs === 0) return

    const timer = setInterval(() => void revalidate().catch(() => {}), refreshMs)
    return () => clearInterval(timer)
  },
})

/**
 * Round-trips through JSON so the value always satisfies storage's Json type.
 * The API key is stripped first: the credential belongs to the integration, and
 * caching a copy would write it to plugin storage in plaintext. Providers
 * restored from cache rely on `integrationID` until the next revalidation
 * resolves the key again.
 */
function saveCacheIn(ctx: Plugin.Context, providers: DiscoveredProvider[]) {
  const withoutKeys = providers.map(({ apiKey: _apiKey, ...provider }) => provider)
  return ctx.storage
    .set(CATALOG_CACHE_KEY, JSON.parse(JSON.stringify({ providers: withoutKeys })))
    .catch(() => {})
}

/**
 * Carries variants forward for any model a revalidation reports none for but
 * that already had some.
 *
 * CLIProxyAPI's reasoning-level endpoint can fail outright or briefly serve an
 * incomplete model list, and both are indistinguishable from "this model has no
 * reasoning levels". Committing that reading strips variants from the picker
 * and overwrites the cache with the loss, so it survives a restart until a
 * healthy poll happens to repair it. Genuine level changes still apply; the
 * cost is that a real removal needs the cache to be cleared.
 */
/**
 * Restores models that a metadata outage stripped back to defaults.
 *
 * Model metadata decides display names, real context limits, modalities, and
 * which models are reached over the Anthropic protocol. Losing it is
 * non-fatal by design, but the resulting catalog is strictly worse, and
 * committing it overwrites the cache so the degraded reading survives a
 * restart — the same failure mode variants had.
 *
 * The whole previous model is carried forward rather than only the
 * metadata-derived fields, because the protocol it resolved to also decides
 * the wire shape of its reasoning variants; mixing an Anthropic package with
 * chat-shaped variant bodies would send levels the endpoint cannot read. The
 * cost is that a genuine change discovered during an outage waits for
 * metadata to come back.
 */
function preserveMetadata(
  fresh: DiscoveredProvider[],
  previous: DiscoveredProvider[],
): DiscoveredProvider[] {
  const known = new Map<string, DiscoveredModel>()
  for (const provider of previous) {
    for (const model of provider.models) {
      if (model.enriched) known.set(`${provider.providerID}/${model.id}`, model)
    }
  }
  if (known.size === 0) return fresh

  return fresh.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      if (model.enriched) return model
      const kept = known.get(`${provider.providerID}/${model.id}`)
      // The id and upstream id belong to the live server, not to the cache.
      return kept ? { ...kept, id: model.id, upstreamID: model.upstreamID } : model
    }),
  }))
}

function preserveVariants(
  fresh: DiscoveredProvider[],
  previous: DiscoveredProvider[],
): DiscoveredProvider[] {
  const known = new Map<string, ModelVariant[]>()
  for (const provider of previous) {
    for (const model of provider.models) {
      if (model.variants?.length) known.set(`${provider.providerID}/${model.id}`, model.variants)
    }
  }
  if (known.size === 0) return fresh

  return fresh.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      if (model.variants.length > 0) return model
      const kept = known.get(`${provider.providerID}/${model.id}`)
      return kept ? { ...model, variants: kept } : model
    }),
  }))
}

export {
  discoverModelProtocols,
  discoverModels,
  discoverThinkingLevels,
  normalizeBaseURL,
  parseCatalog,
  parseModelProtocolCatalog,
  parseThinkingLevels,
} from "./catalog.js"
export type {
  CatalogModel,
  ModelMetadata,
  ModelProtocolCatalog,
  ThinkingLevelCatalog,
} from "./catalog.js"

/**
 * Resolves connection settings, queries CLIProxyAPI for its live catalog, and
 * enriches each model with metadata. Metadata failures are non-fatal: the
 * discovered models stay available using the provider's default protocol.
 */
export async function discoverCatalog(options: ConnectorOptions): Promise<DiscoveredProvider[]> {
  const defaultProviderID = options.providerID ?? DEFAULT_PROVIDER_ID
  const baseURL = normalizeBaseURL(
    options.baseURL ?? process.env.CLIPROXY_BASE_URL ?? DEFAULT_BASE_URL,
  )
  const apiKey = options.apiKey ?? stringOption(process.env.CLIPROXY_API_KEY)
  const timeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  const protocol = options.protocol ?? "chat"

  const [models, metadata, thinking] = await Promise.all([
    discoverModels({ baseURL, apiKey, timeoutMs }),
    discoverMetadata({
      url: options.modelMetadataURL ?? DEFAULT_MODEL_METADATA_URL,
      timeoutMs,
    }),
    discoverThinking({
      enabled: options.thinkingLevels ?? true,
      baseURL,
      apiKey,
      timeoutMs,
    }),
  ])

  const providerNpm = protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible"
  const described = models.map((model) => describeModel(model, metadata, thinking, protocol))

  return groupProviders(
    described,
    {
      defaultProviderID,
      defaultProviderName: options.providerName ?? DEFAULT_PROVIDER_NAME,
      package: aisdk(providerNpm),
      baseURL,
      apiKey,
    },
    options.groupByPrefix ?? true,
  )
}

/**
 * Splits the flat CLIProxyAPI catalog into one OpenCode provider per group
 * prefix found in a model id (the part before the first `/`). Each group
 * becomes its own section in the model picker, while models without a prefix
 * fall back to the configured default provider. The catalog key drops the
 * prefix; the full id is preserved on `upstreamID` so requests still reach
 * CLIProxyAPI unchanged.
 */
function groupProviders(
  models: DiscoveredModel[],
  base: {
    defaultProviderID: string
    defaultProviderName: string
    package: string
    baseURL: string
    apiKey?: string
  },
  group: boolean,
): DiscoveredProvider[] {
  const buckets = new Map<string, DiscoveredModel[]>()

  for (const model of models) {
    const slash = group ? model.id.indexOf("/") : -1
    const providerID = slash >= 0 ? model.id.slice(0, slash) : base.defaultProviderID
    const catalogKey = slash >= 0 ? model.id.slice(slash + 1) : model.id

    // The auto-generated name derives from the full id, so re-derive it from
    // the stripped key when grouping; a metadata-provided name is kept as-is.
    const autoName = displayName(model.upstreamID)
    const entry: DiscoveredModel = {
      ...model,
      id: catalogKey,
      upstreamID: model.upstreamID,
      name: slash >= 0 && model.name === autoName ? displayName(catalogKey) : model.name,
    }

    const bucket = buckets.get(providerID)
    if (bucket) bucket.push(entry)
    else buckets.set(providerID, [entry])
  }

  dropShadowedDefaults(buckets, base.defaultProviderID)

  return [...buckets.entries()].map(([bucketKey, groupedModels]) => {
    // Grouped providers must not collide with OpenCode's built-in providers.
    // A bare prefix like "anthropic" would land on the built-in provider of
    // the same name and entangle this connector's models with that provider's
    // own credential and activation state. Prefixing with the default provider
    // ID creates a fresh provider this plugin fully owns.
    const grouped = bucketKey !== base.defaultProviderID
    const providerID = grouped ? `${base.defaultProviderID}-${bucketKey}` : bucketKey
    return {
      providerID,
      providerName: grouped
        ? `${prettifyProvider(bucketKey)} (${base.defaultProviderName})`
        : base.defaultProviderName,
      package: base.package,
      baseURL: base.baseURL,
      ...(base.apiKey ? { apiKey: base.apiKey } : {}),
      models: groupedModels,
    }
  })
}

/**
 * CLIProxyAPI commonly serves the same model twice: once namespaced
 * (`anthropic/claude-sonnet-4-6`) and once flat (`claude-sonnet-4-6`). Both
 * resolve to the same catalog key, so the flat copy would show up as a second,
 * indistinguishable entry under the default provider. Drop it and keep the
 * namespaced one, whose upstream id is unambiguous to the proxy.
 *
 * Flat models with no namespaced counterpart — aliases such as
 * `claude-sonnet-4.6` — are untouched.
 */
function dropShadowedDefaults(
  buckets: Map<string, DiscoveredModel[]>,
  defaultProviderID: string,
) {
  const fallback = buckets.get(defaultProviderID)
  if (!fallback) return

  const namespaced = new Set<string>()
  for (const [bucketKey, models] of buckets) {
    if (bucketKey === defaultProviderID) continue
    for (const model of models) namespaced.add(model.id)
  }
  if (namespaced.size === 0) return

  const kept = fallback.filter((model) => !namespaced.has(model.id))
  // An emptied fallback must be removed outright, otherwise it registers as a
  // provider with no models.
  if (kept.length === 0) buckets.delete(defaultProviderID)
  else buckets.set(defaultProviderID, kept)
}

function describeModel(
  model: CatalogModel,
  catalog: ModelProtocolCatalog,
  thinking: ThinkingLevelCatalog,
  protocol: "chat" | "responses",
): DiscoveredModel {
  const metadata = resolveMetadata(catalog, model)
  const image = isImageModel(model.id)
  const anthropic = metadata?.npm === ANTHROPIC_NPM
  const levels = thinking[model.id] ?? []

  return {
    id: model.id,
    upstreamID: model.id,
    name: metadata?.name ?? displayName(model.id),
    // Only Anthropic-compatible models need to leave the provider's default
    // protocol; everything else inherits the provider package.
    ...(anthropic ? { package: aisdk(ANTHROPIC_NPM) } : {}),
    tools: metadata?.toolCall ?? !image,
    input: metadata?.modalities?.input ?? (image ? ["text", "image"] : ["text"]),
    output: metadata?.modalities?.output ?? (image ? ["image"] : ["text"]),
    limit: metadata?.limit ?? FALLBACK_LIMIT,
    variants: levels.map((level) => ({
      id: level,
      body: thinkingBody(level, anthropic ? "messages" : protocol),
    })),
    // Anthropic and Responses traffic already carries reasoning in a shape
    // OpenCode understands.
    ...(anthropic || protocol === "responses" ? {} : { reasoningField: CHAT_REASONING_FIELD }),
    enriched: metadata !== undefined,
  }
}

/**
 * Renders one reasoning level in the wire format CLIProxyAPI reads for the
 * protocol the model is reached over. CLIProxyAPI extracts the level from the
 * incoming request and re-applies it in the upstream provider's own format, so
 * only the shape of the endpoint being called matters here.
 */
function thinkingBody(level: string, protocol: "chat" | "responses" | "messages") {
  if (protocol === "messages") {
    // Adaptive thinking is converted to a token budget for models that only
    // support budgets, so this stays correct for older Claude models.
    return { thinking: { type: "adaptive" }, output_config: { effort: level } }
  }
  if (protocol === "responses") return { reasoning: { effort: level } }
  return { reasoning_effort: level }
}

/**
 * Model-level metadata wins over the provider-level default so a provider that
 * is mostly Anthropic can still expose an OpenAI-compatible model.
 */
function resolveMetadata(
  catalog: ModelProtocolCatalog,
  model: CatalogModel,
): ModelMetadata | undefined {
  if (!model.ownedBy) return
  const provider = catalog[model.ownedBy]
  if (!provider) return

  // CLIProxyAPI group prefixes (e.g. "anthropic/claude-sonnet-4-6") are a
  // routing convention unknown to models.dev; strip the prefix so the lookup
  // reaches the canonical short id that models.dev actually indexes.
  const slash = model.id.indexOf("/")
  const canonicalID = slash >= 0 ? model.id.slice(slash + 1) : model.id

  const entry = provider.models[canonicalID]
  if (entry) return entry.npm ? entry : { ...entry, npm: provider.npm }
  return provider.npm ? { npm: provider.npm } : undefined
}

async function discoverMetadata(input: {
  url: string | false
  timeoutMs: number
}): Promise<ModelProtocolCatalog> {
  if (input.url === false) return {}

  try {
    return await discoverModelProtocols({ url: input.url, timeoutMs: input.timeoutMs })
  } catch {
    // Metadata only refines the catalog. Losing it must not hide the models.
    return {}
  }
}

async function discoverThinking(input: {
  enabled: boolean
  baseURL: string
  apiKey?: string
  timeoutMs: number
}): Promise<ThinkingLevelCatalog> {
  if (!input.enabled) return {}

  try {
    return await discoverThinkingLevels(input)
  } catch {
    // Servers predating the Codex client catalog still serve models; they just
    // cannot offer reasoning variants.
    return {}
  }
}

/**
 * Restores the last successfully discovered catalog from plugin storage so a
 * cold start can register models before any network round-trip. Malformed or
 * pre-grouping cache entries are dropped rather than trusted: a missing cache
 * only costs the one-time discovery wait, while a corrupt one would register
 * broken providers.
 */
export function parseCachedCatalog(input: unknown): DiscoveredProvider[] {
  const cached = input as { providers?: unknown } | undefined
  if (!cached || !Array.isArray(cached.providers)) return []

  return cached.providers.flatMap((provider) => {
    if (
      typeof provider !== "object" ||
      provider === null ||
      typeof (provider as DiscoveredProvider).providerID !== "string" ||
      !Array.isArray((provider as DiscoveredProvider).models)
    ) {
      return []
    }
    const entry = provider as DiscoveredProvider
    const models = entry.models.filter(
      (model) => typeof model === "object" && model !== null && typeof model.id === "string",
    )
    return models.length > 0 ? [{ ...entry, models }] : []
  })
}

/**
 * Reads connection settings from the credential OpenCode holds for the
 * integration. Explicit plugin options still win, so an existing config-driven
 * setup keeps working untouched; the credential only fills the gaps.
 */
async function readCredential(
  ctx: Pick<Plugin.Context, "integration">,
  configured: ConnectorOptions,
): Promise<Partial<ConnectorOptions>> {
  try {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (!connection) return {}

    const credential = await ctx.integration.connection.resolve(connection)
    if (credential?.type !== "key") return {}

    return {
      ...(configured.apiKey ? {} : { apiKey: stringOption(credential.key) }),
      ...(configured.baseURL
        ? {}
        : { baseURL: stringOption(credential.configuration?.baseURL) }),
    }
  } catch {
    // An unresolvable credential is equivalent to none; fall back to options.
    return {}
  }
}

function readOptions(input?: Record<string, unknown>): ConnectorOptions {
  if (!input) return {}

  return {
    baseURL: stringOption(input.baseURL),
    apiKey: stringOption(input.apiKey),
    providerID: stringOption(input.providerID),
    providerName: stringOption(input.providerName),
    protocol:
      input.protocol === "responses" ? "responses" : input.protocol === "chat" ? "chat" : undefined,
    groupByPrefix:
      typeof input.groupByPrefix === "boolean" ? input.groupByPrefix : undefined,
    thinkingLevels:
      typeof input.thinkingLevels === "boolean" ? input.thinkingLevels : undefined,
    modelMetadataURL:
      input.modelMetadataURL === false ? false : stringOption(input.modelMetadataURL),
    discoveryTimeoutMs:
      typeof input.discoveryTimeoutMs === "number" && input.discoveryTimeoutMs > 0
        ? input.discoveryTimeoutMs
        : undefined,
    refreshMs: typeof input.refreshMs === "number" && input.refreshMs >= 0 ? input.refreshMs : undefined,
    coldWaitMs:
      typeof input.coldWaitMs === "number" && input.coldWaitMs >= 0 ? input.coldWaitMs : undefined,
  }
}

/**
 * Reports discovery health on transitions only.
 *
 * A failed discovery is invisible by design — the cached catalog keeps
 * serving — which leaves a stale catalog with nothing explaining it. The
 * plugin context offers no logger, so this goes to stderr, where OpenCode's
 * own logs are. Reporting every attempt would fill the log with one entry per
 * poll for as long as a server stays down, so only the healthy/failing edges
 * are worth an entry.
 */
function diagnostics() {
  let failing = false
  return {
    failed: (detail: string) => {
      if (failing) return
      failing = true
      console.warn(
        `[opencode-cliproxyapi] model discovery failed, serving the cached catalog: ${detail}`,
      )
    },
    recovered: () => {
      if (!failing) return
      failing = false
      console.warn("[opencode-cliproxyapi] model discovery recovered")
    },
  }
}

/**
 * A timer that can be awaited once and cancelled, so a discovery that beats
 * the cap does not leave a pending timer holding the event loop open.
 */
function deadline(ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    promise: new Promise<void>((resolve) => {
      if (ms === 0) return resolve()
      timer = setTimeout(resolve, ms)
    }),
    cancel: () => clearTimeout(timer),
  }
}

function aisdk(npm: string) {
  return `aisdk:${npm}`
}

function stringOption(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function displayName(modelID: string) {
  return modelID
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === "gpt") return "GPT"
      if (lower === "oss") return "OSS"
      if (lower === "codex") return "Codex"
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(" ")
}

function isImageModel(modelID: string) {
  return /(?:^|-)image(?:-|$)/i.test(modelID)
}

function prettifyProvider(prefix: string) {
  return prefix
    .split(/[-/]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ")
}
