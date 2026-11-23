import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-llm'
import type { SessionRequestId, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelectionInput } from '../../contracts/src/index.ts'

const HANAI_AGENT_PRESET = 'standard'

export class DshSessionGateway {
  constructor(private readonly ctx: Context) {}

  async listModels(provider: string): Promise<readonly string[]> {
    return (await this.ctx.llm.listModels(provider)).map(model => model.id)
  }

  async create(judgementId: string, cwd: string, model?: ModelSelectionInput, options?: { rememberModel: boolean }): Promise<string> {
    const sessionOnly = options?.rememberModel === false
    if (sessionOnly && model) await this.ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model })
    const requestedId = SessionId(`hanai-${judgementId}`)
    const created = await this.ctx.sessionController.create({
      cwd, sessionId: requestedId, agentPreset: HANAI_AGENT_PRESET,
    })
    if (created.agentPreset !== HANAI_AGENT_PRESET) {
      const actual = created.agentPreset === undefined ? '未返回' : `"${created.agentPreset}"`
      await this.rejectCreatedSession(
        created.sessionId,
        new Error(`DSH Session 未使用必需的 Agent Preset "${HANAI_AGENT_PRESET}"（实际：${actual}）`),
      )
    }
    if (model !== undefined) {
      try {
        if (sessionOnly) {
          const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
          if ('error' in resolved) throw resolved.error
          resolved.agent.model.select({ provider: model.provider, model: model.model })
        } else {
          await this.ctx.sessionController.selectModel({
            sessionId: created.sessionId,
            provider: model.provider,
            model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          })
        }
      } catch (error) {
        await this.rejectCreatedSession(created.sessionId, error)
      }
    }
    return created.sessionId
  }

  private async rejectCreatedSession(sessionId: string, error: unknown): Promise<never> {
    try {
      await this.archive(sessionId)
    } catch (cleanupError) {
      throw new Error(
        `${messageOf(error)}；未绑定 Session 归档失败：${messageOf(cleanupError)}`,
        { cause: error },
      )
    }
    throw error
  }

  /** DSH has no session deletion API; archiving is its durable orphan-cleanup primitive. */
  async archive(sessionId: string): Promise<void> {
    await this.ctx.workspaceController.archiveSession({ sessionId: SessionId(sessionId) })
  }

  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId: SessionId(sessionId),
      mode,
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  }

  async history(sessionId: string, maxMessages = 10): Promise<SessionWireEvent[]> {
    const { records } = await this.ctx.sessionController.page({
      address: { kind: 'session', sessionId: SessionId(sessionId) }, maxMessages,
    }, new AbortController().signal)
    return records.map(record => record.event)
  }

  async isRunning(sessionId: string): Promise<boolean> {
    const list = await this.ctx.sessionController.list({}, new AbortController().signal)
    return list.items.find(item => item.sessionId === sessionId)?.running ?? false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
