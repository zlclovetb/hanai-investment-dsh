import type { ModelSelectionInput } from '../../contracts/src/index.ts'

export const CODEX_PROVIDER = 'openai-codex'
const FLASH_MODEL = 'deepseek-flash'
const flashProviders = ['modlens-deepseek-account', 'deepseek-account', 'deepseek-official']
const unavailableCodes = new Set([
  'ACCOUNT_QUOTA', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID', 'AUTH',
  'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'MODEL_NOT_FOUND', 'MODEL_UNSUPPORTED',
  'NO_ADAPTER', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'STREAM_CLOSED', 'TIMEOUT', 'TRANSPORT', 'UNKNOWN_MODEL',
  'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
])
const unavailableStatuses = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504])
const codexStatusMessages = new Set([
  'unauthorized', 'forbidden', 'payment required', 'too many requests', 'request timeout',
  'internal server error', 'bad gateway', 'service unavailable', 'gateway timeout',
  'fetch failed', 'failed to extract accountid from token',
])

export type CycleModel = Pick<ModelSelectionInput, 'provider' | 'model'>
type ListModels = (provider: string) => Promise<readonly string[]>

function unavailableFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const failure = 'failure' in error ? error.failure : error
  if (typeof failure !== 'object' || failure === null) return false
  if ('status' in failure && typeof failure.status === 'number' && unavailableStatuses.has(failure.status)) return true
  const code = 'code' in failure && typeof failure.code === 'string' ? failure.code : undefined
  if (code && (unavailableCodes.has(code) || unavailableStatuses.has(Number(/^HTTP_(\d{3})$/.exec(code)?.[1])))) return true
  if (!('message' in failure) || typeof failure.message !== 'string') return false
  const message = failure.message
  if (code === 'CODEX_CATALOG' || code === 'CODEX_REQUEST') {
    const status = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1]
    if (unavailableStatuses.has(Number(status))) return true
  }
  if (code === 'CODEX_REQUEST' && (codexStatusMessages.has(message.trim().toLowerCase())
    || /^(?:You have hit your ChatGPT usage limit\b|Codex SSE response headers timed out after \d+ms)/i.test(message))) return true
  if (!code || code === 'UNKNOWN' || code === 'CODEX_REQUEST') {
    return /\b(?:token_revoked|invalid_refresh_token|refresh_token_expired|refresh_token_reused|refresh_token_invalidated|invalid_grant|usage_limit_reached|insufficient_quota|rate_limit_exceeded)\b/i.test(message)
      || /\b(?:No Codex account offers the selected model|Codex CLI login expired|Codex CLI pool .* has no usable login|Cannot read Codex CLI login)\b/i.test(message)
  }
  return false
}

export function modelUnavailable(error: unknown): boolean {
  return unavailableFailure(error) || (error instanceof Error && unavailableFailure(error.cause))
}

async function modelsFor(list: ListModels, provider: string) {
  try { return await list(provider) }
  catch (error) {
    if (!modelUnavailable(error)) throw error
    return []
  }
}

export async function codexModel(list: ListModels, preferred: ModelSelectionInput): Promise<CycleModel | undefined> {
  const models = await modelsFor(list, CODEX_PROVIDER)
  const model = preferred.provider === CODEX_PROVIDER && models.includes(preferred.model) ? preferred.model : models[0]
  return model ? { provider: CODEX_PROVIDER, model } : undefined
}

export async function flashModel(list: ListModels, preferredProvider: string): Promise<CycleModel> {
  const providers = flashProviders.includes(preferredProvider)
    ? [preferredProvider, ...flashProviders.filter(provider => provider !== preferredProvider)] : flashProviders
  for (const provider of providers) {
    if ((await modelsFor(list, provider)).includes(FLASH_MODEL)) return { provider, model: FLASH_MODEL }
  }
  throw new Error('Codex 不可用，DSH 未提供 DeepSeek V4.1 Flash（deepseek-flash）')
}
