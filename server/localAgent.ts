import { CLAUDE_EFFORTS, isClaudeModel } from '../shared/localAgent.ts'
import { Router, type Request, type Response } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { localAgentRuns } from './localAgentRuns.ts'
import { getLocalAgentPreference, saveLocalAgentPreference } from './localAgentPreferences.ts'
import { store } from './store.ts'
import { canEditCanvas } from './access.ts'
import { isBanned } from './auth.ts'
import { onFeedback } from './resident.ts'
import { isAgentKeySecret, verifyAgentKey } from './agentKeys.ts'

export const localAgentRouter = Router()
/* an alias or a pinned claude-* id (the shell checks the shape again before
   it becomes a CLI argument), and the CLI's effort levels or none */
const preferenceSchema = z.object({
  enabled: z.boolean(),
  model: z.string().max(120).refine(isClaudeModel, 'Invalid model'),
  effort: z.enum(CLAUDE_EFFORTS).optional(),
})
const deviceSchema = z.object({ deviceId: z.string().uuid() })

localAgentRouter.get('/', (req, res, next) => {
  getLocalAgentPreference(req.user!.id)
    .then((preference) => res.json({ ...preference, online: localAgentRuns.online(req.user!.id) }))
    .catch(next)
})

localAgentRouter.put('/', (req, res, next) => {
  const parsed = preferenceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid local agent preference' })
    return
  }
  const userId = req.user!.id
  void (async () => {
    if (!parsed.data.enabled) await localAgentRuns.cancel(userId)
    await saveLocalAgentPreference(userId, parsed.data)
    res.json(await getLocalAgentPreference(userId))
    wake(userId)
  })().catch(next)
})

function wake(userId: string) {
  for (const canvas of store.canvases.values()) if (canEditCanvas(userId, canvas)) onFeedback(canvas.id)
}

// POST: polling claims a run and is prohibited in read-only impersonation sessions.
localAgentRouter.post('/poll', (req, res, next) => {
  poll(req.user!.id, req, res).catch(next)
})

localAgentRouter.post('/finish/:id', (req, res, next) => {
  finish(req.user!.id, req, res).catch(next)
})

async function poll(userId: string, req: Request, res: Response) {
  const parsed = deviceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device' })
    return
  }
  const preference = await getLocalAgentPreference(userId)
  if (!preference.enabled) {
    res.json({ job: null, enabled: false })
    return
  }
  const wasOnline = localAgentRuns.online(userId)
  const job = localAgentRuns.poll(userId, parsed.data.deviceId)
  res.json({ job, enabled: true })
  if (!wasOnline) wake(userId)
}

async function finish(userId: string, req: Request, res: Response) {
  const parsed = deviceSchema.extend({ success: z.boolean(), text: z.string().max(100_000) }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid result' })
    return
  }
  const ok = await localAgentRuns.finish(req.params.id!, userId, parsed.data.deviceId, parsed.data)
  res.status(ok ? 200 : 409).json({ ok })
}

/**
 * The same relay for a headless runner (scripts/claude-runner.mjs): a machine
 * with a Claude Code login and no browser session, so it authenticates with
 * one of the account's agent keys. A key already acts as its owner on /mcp,
 * so claiming that owner's queued runs grants nothing new. Mounted ahead of
 * the /api session gate.
 */
export const localRunnerRouter = Router()

localRunnerRouter.use((req, res, next) => {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
  void (async () => {
    const key = isAgentKeySecret(bearer) ? await verifyAgentKey(bearer) : null
    if (!key || (await isBanned(key.userId))) {
      res.status(401).json({ error: 'Invalid agent key' })
      return
    }
    res.locals.userId = key.userId
    next()
  })().catch(next)
})

localRunnerRouter.get('/', (_req, res, next) => {
  getLocalAgentPreference(res.locals.userId as string)
    .then((preference) => res.json(preference))
    .catch(next)
})

localRunnerRouter.post('/poll', (req, res, next) => {
  poll(res.locals.userId as string, req, res).catch(next)
})

localRunnerRouter.post('/finish/:id', (req, res, next) => {
  finish(res.locals.userId as string, req, res).catch(next)
})

localAgentRouter.post('/stop', (req, res, next) => {
  localAgentRuns
    .cancel(req.user!.id)
    .then(() => res.json({ ok: true }))
    .catch(next)
})

/** An unguessable, short-lived run token grants only this canvas's resident tools.
 * Recheck membership and bans on every request, independently of browser cookies. */
export async function handleLocalAgentMcp(req: Request, res: Response) {
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
  const id = req.params.id ?? ''
  const run = localAgentRuns.authorized(id, token)
  const canvas = run && store.getCanvas(run.request.canvasId)
  if (!run || !canvas || !canEditCanvas(run.userId, canvas) || (await isBanned(run.userId))) {
    res.status(403).json({ error: 'Local run unavailable' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  const server = new Server({ name: 'doop', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: run.request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await localAgentRuns.execute(id, token, params.name, params.arguments ?? {})
    const content: ContentBlock[] = []
    if (typeof result.content === 'string') content.push({ type: 'text', text: result.content })
    else
      for (const block of result.content ?? []) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'image' && block.source.type === 'base64') {
          content.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type })
        }
      }
    return { content, isError: !!result.is_error }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
