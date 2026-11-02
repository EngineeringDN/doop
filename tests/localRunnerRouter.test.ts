import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const banned = new Set<string>()
vi.mock('../server/auth.ts', () => ({ isBanned: async (user: string) => banned.has(user) }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/localAgentPreferences.ts', () => ({
  getLocalAgentPreference: vi.fn(async () => ({ enabled: true, model: 'sonnet' })),
  saveLocalAgentPreference: vi.fn(),
}))
vi.mock('../server/agentKeys.ts', () => ({
  isAgentKeySecret: (bearer: string) => bearer.startsWith('dpk_'),
  verifyAgentKey: async (secret: string) =>
    secret === 'dpk_alice' ? { userId: 'alice' } : secret === 'dpk_mallory' ? { userId: 'mallory' } : null,
}))
vi.mock('../server/access.ts', () => ({ canEditCanvas: () => true }))
vi.mock('../server/store.ts', () => ({ store: { getCanvas: (id: string) => ({ id }), canvases: new Map() } }))

import { localRunnerRouter } from '../server/localAgent.ts'
import { localAgentRuns } from '../server/localAgentRuns.ts'

let server: HttpServer
let origin: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/local-agent/runner', localRunnerRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const deviceId = '7f8f7a52-6e57-4c4a-9e0b-2b8e7a3c1d10'
const call = (path: string, key: string, body?: unknown) =>
  fetch(`${origin}/local-agent/runner${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

describe('headless runner relay', () => {
  it('refuses requests without a valid agent key, and banned owners', async () => {
    expect((await call('', 'not-a-key')).status).toBe(401)
    expect((await call('', 'dpk_unknown')).status).toBe(401)
    banned.add('mallory')
    expect((await call('/poll', 'dpk_mallory', { deviceId })).status).toBe(401)
    banned.delete('mallory')
  })

  it("claims the key owner's run and finishes it", async () => {
    const result = localAgentRuns.start(
      'alice',
      { model: 'sonnet' },
      {
        canvasId: 'c1',
        prompt: 'Design a hero',
        system: 'You design.',
        tools: [],
        maxTurns: 4,
        execute: vi.fn(),
      },
    )
    const polled = await call('/poll', 'dpk_alice', { deviceId })
    const { job, enabled } = (await polled.json()) as { job: { id: string; prompt: string }; enabled: boolean }
    expect(enabled).toBe(true)
    expect(job.prompt).toBe('Design a hero')

    const other = await call('/poll', 'dpk_mallory', { deviceId })
    expect(((await other.json()) as { job: unknown }).job).toBeNull()

    const finished = await call(`/finish/${job.id}`, 'dpk_alice', { deviceId, success: true, text: 'Done' })
    expect(finished.status).toBe(200)
    await expect(result).resolves.toMatchObject({ success: true, text: 'Done' })
    expect((await call(`/finish/${job.id}`, 'dpk_alice', { deviceId, success: true, text: 'Again' })).status).toBe(409)
  })
})
