export type CatalogModel = {
  id: string
  ownedBy?: string
}

/**
 * Model-level metadata sourced from a models.dev-compatible service. Every
 * field is optional because the service only knows about publicly documented
 * models, while CLIProxyAPI may expose anything.
 */
export type ModelMetadata = {
  npm?: string
  name?: string
  toolCall?: boolean
  limit?: { context: number; output: number }
  modalities?: { input: string[]; output: string[] }
}

export type ModelProtocolCatalog = Record<
  string,
  {
    npm?: string
    models: Record<string, ModelMetadata>
  }
>

/** Discrete reasoning levels a model accepts, keyed by CLIProxyAPI model id. */
export type ThinkingLevelCatalog = Record<string, string[]>

type CatalogResponse = {
  data?: unknown
}

/**
 * CLIProxyAPI clones this model's catalog entry as the template for every model
 * it has to describe without registry knowledge, so its reasoning levels are the
 * fingerprint of a fabricated entry.
 */
const TEMPLATE_MODEL_ID = "gpt-5.5"

/** Used when the template model itself is not exposed by the server. */
const TEMPLATE_FALLBACK_LEVELS = ["low", "medium", "high", "xhigh"]

/**
 * Key that CLIProxyAPI deletes when it generates an entry rather than serving a
 * genuine Codex template, which makes it a reliable marker of template entries.
 */
const TEMPLATE_MARKER = "apply_patch_tool_type"

export function normalizeBaseURL(value: string) {
  const url = new URL(value)
  const pathname = url.pathname.replace(/\/+$/, "")
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`
  return url.toString().replace(/\/$/, "")
}

export function parseCatalog(input: unknown): CatalogModel[] {
  if (!isRecord(input)) throw new Error("CLIProxyAPI returned a non-object model catalog")

  const response: CatalogResponse = input
  if (!Array.isArray(response.data)) throw new Error("CLIProxyAPI model catalog is missing the data array")

  const models = response.data
    .map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") return
      return {
        id: item.id,
        ...(typeof item.owned_by === "string" ? { ownedBy: item.owned_by } : {}),
      }
    })
    .filter((item): item is CatalogModel => item !== undefined)

  if (models.length === 0) throw new Error("CLIProxyAPI returned no usable models")

  const unique = new Map<string, CatalogModel>()
  for (const model of models) {
    if (!unique.has(model.id)) unique.set(model.id, model)
  }
  return [...unique.values()]
}

export async function discoverModels(input: {
  baseURL: string
  apiKey?: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const response = await (input.fetcher ?? fetch)(`${input.baseURL}/models`, {
    headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined,
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `CLIProxyAPI model discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseCatalog(await response.json())
}

/**
 * Reads reasoning levels from CLIProxyAPI's Codex client catalog
 * (`/models?client_version=1`).
 *
 * The server answers that request by cloning a template entry for every model
 * and only overwriting the reasoning levels when its registry actually knows
 * the model's thinking support. Models it does not know therefore advertise the
 * template's levels, which is how non-reasoning models end up claiming to
 * support `xhigh`. Entries whose levels are indistinguishable from the template
 * are dropped: a missing level list costs a variant, while a fabricated one
 * sends an unsupported `reasoning_effort` upstream.
 */
export function parseThinkingLevels(input: unknown): ThinkingLevelCatalog {
  if (!isRecord(input)) throw new Error("CLIProxyAPI returned a non-object thinking catalog")
  if (!Array.isArray(input.models)) {
    throw new Error("CLIProxyAPI thinking catalog is missing the models array")
  }

  const entries = input.models.filter(isRecord)
  const templateLevels = detectTemplateLevels(entries)

  return Object.fromEntries(
    entries.flatMap((entry) => {
      const id = typeof entry.slug === "string" ? entry.slug.trim() : ""
      if (id === "") return []

      const levels = parseReasoningLevels(entry.supported_reasoning_levels)
      if (!levels) return []

      // Genuine template entries keep their levels even when they match, since
      // the template is their real source rather than a fallback.
      if (!isTemplateEntry(entry) && sameLevels(levels, templateLevels)) return []

      return [[id, levels] as const]
    }),
  )
}

export async function discoverThinkingLevels(input: {
  baseURL: string
  apiKey?: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const response = await (input.fetcher ?? fetch)(`${input.baseURL}/models?client_version=1`, {
    headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined,
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `CLIProxyAPI thinking discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseThinkingLevels(await response.json())
}

function detectTemplateLevels(entries: Record<string, unknown>[]) {
  const template = entries.find((entry) => entry.slug === TEMPLATE_MODEL_ID && isTemplateEntry(entry))
  return (template && parseReasoningLevels(template.supported_reasoning_levels)) ?? TEMPLATE_FALLBACK_LEVELS
}

function isTemplateEntry(entry: Record<string, unknown>) {
  return TEMPLATE_MARKER in entry
}

function parseReasoningLevels(value: unknown) {
  if (!Array.isArray(value)) return
  const levels = value.flatMap((item) =>
    isRecord(item) && typeof item.effort === "string" && item.effort.trim() !== ""
      ? [item.effort.trim()]
      : [],
  )
  return levels.length > 0 ? levels : undefined
}

function sameLevels(left: string[], right: string[]) {
  return left.length === right.length && left.every((level, index) => level === right[index])
}

export function parseModelProtocolCatalog(input: unknown): ModelProtocolCatalog {
  if (!isRecord(input)) throw new Error("Model metadata service returned a non-object catalog")

  return Object.fromEntries(
    Object.entries(input).flatMap(([providerID, provider]) => {
      if (!isRecord(provider)) return []

      const models = Object.fromEntries(
        Object.entries(isRecord(provider.models) ? provider.models : {}).flatMap(([modelID, model]) => {
          if (!isRecord(model)) return []
          const metadata = parseModelMetadata(model)
          return Object.keys(metadata).length > 0 ? [[modelID, metadata]] : []
        }),
      )

      const npm = typeof provider.npm === "string" ? provider.npm : undefined
      return npm || Object.keys(models).length > 0
        ? [[providerID, { ...(npm ? { npm } : {}), models }]]
        : []
    }),
  )
}

export async function discoverModelProtocols(input: {
  url: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const response = await (input.fetcher ?? fetch)(input.url, {
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `Model protocol discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseModelProtocolCatalog(await response.json())
}

function parseModelMetadata(model: Record<string, unknown>): ModelMetadata {
  const npm =
    isRecord(model.provider) && typeof model.provider.npm === "string" ? model.provider.npm : undefined
  const limit = parseLimit(model.limit)
  const modalities = parseModalities(model.modalities)

  return {
    ...(npm ? { npm } : {}),
    ...(typeof model.name === "string" && model.name.trim() !== "" ? { name: model.name } : {}),
    ...(typeof model.tool_call === "boolean" ? { toolCall: model.tool_call } : {}),
    ...(limit ? { limit } : {}),
    ...(modalities ? { modalities } : {}),
  }
}

function parseLimit(input: unknown) {
  if (!isRecord(input)) return
  const context = input.context
  const output = input.output
  if (!isPositiveInteger(context) || !isPositiveInteger(output)) return
  return { context, output }
}

function parseModalities(input: unknown) {
  if (!isRecord(input)) return
  const inputModalities = parseStringArray(input.input)
  const outputModalities = parseStringArray(input.output)
  if (!inputModalities || !outputModalities) return
  return { input: inputModalities, output: outputModalities }
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) return
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
  return items.length > 0 ? items : undefined
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
