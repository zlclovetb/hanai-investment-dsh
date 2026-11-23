import { describe, expect, it } from 'vitest'
import { inject } from '../src/index.ts'

describe('Hanai Host composition requirements', () => {
  it('waits for DSH model routing and the default model service before mounting RPC', () => {
    expect(inject).toEqual([
      'connection',
      'webServer',
      'sessionController',
      'workspaceController',
      'sessions',
      'agentDefaultModel',
      'llm',
    ])
  })
})
