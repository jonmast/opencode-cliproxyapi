import { Plugin } from "@opencode-ai/plugin"
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
const DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json"
const ANTHROPIC_NPM = "@ai-sdk/anthropic"

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

    const options = { ...configured, ...(await readCredential(ctx, configured)) }

    // A missing or unreachable server must not take the plugin down with it,
    // otherwise the integration disappears and the key can never be entered.
    const catalog = await discoverCatalog(options).catch(() => [] as DiscoveredProvider[])

    await ctx.catalog.transform((draft) => {
      for (const provider of catalog) {

        draft.provider.update(provider.providerID, (p) => {
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
          draft.model.update(provider.providerID, model.id, (draftModel) => {
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
  },
})

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
