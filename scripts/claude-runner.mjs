#!/usr/bin/env node
/**
 * Headless Claude Plan runner: the desktop shell's local Claude relay
 * (desktop/src-tauri/src/claude.rs) for a machine with a Claude Code login and
 * no Doop desktop app, such as a home server. It claims the account's queued
 * Doop Agent runs over /local-agent/runner and runs each one with `claude -p`,
 * limited to that run's canvas-scoped Doop MCP tools.
 *
 *   DOOP_URL=http://doop.lan DOOP_AGENT_KEY=dpk_… node scripts/claude-runner.mjs
 *
 * DOOP_AGENT_KEY_FILE may name a file holding the key instead. CLAUDE_BIN
 * overrides the `claude` found on PATH. Only Node's standard library is used.
 */
/* global AbortSignal */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const POLL_MS = 3000
const RUN_TIMEOUT_MS = 30 * 60_000
const MAX_LINE_BYTES = 2 * 1024 * 1024
const MODEL_ALIASES = ['default', 'fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/* An explicit subscription mode must not accidentally spend an inherited API key. */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE',
]

const baseUrl = (process.env.DOOP_URL ?? '').replace(/\/+$/, '')
const agentKey = (
  process.env.DOOP_AGENT_KEY ??
  (process.env.DOOP_AGENT_KEY_FILE ? await readFile(process.env.DOOP_AGENT_KEY_FILE, 'utf8') : '')
).trim()
const claudeBin = process.env.CLAUDE_BIN ?? 'claude'
if (!/^https?:\/\/[^/]+/.test(baseUrl) || !agentKey.startsWith('dpk_')) {
  console.error('Set DOOP_URL (http[s]://host) and DOOP_AGENT_KEY or DOOP_AGENT_KEY_FILE (a dpk_ agent key).')
  process.exit(2)
}

/* one claimant per process lifetime, as the desktop has one per webview */
const deviceId = randomUUID()
/** @type {{ id: string, child?: import('node:child_process').ChildProcess, stopped: boolean } | null} */
let active = null
/** @type {{ id: string, result: { success: boolean, text: string } } | null} */
let completed = null
let lastError = ''

const log = (...args) => console.log(new Date().toISOString(), ...args)

async function call(path, body) {
  const res = await fetch(`${baseUrl}/local-agent/runner${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${agentKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 409) return null
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

/* Mirrors isClaudeModel / CLAUDE_EFFORTS in shared/localAgent.ts. Each value
   becomes one argv element, so the shape rule is the whole guard. */
const validModel = (model) => MODEL_ALIASES.includes(model) || /^claude-[a-z0-9][a-z0-9.-]{0,98}$/.test(model)

function validate(job) {
  if (!/^[0-9a-f-]{36}$/i.test(job.id ?? '')) return 'Invalid run id'
  if (!/^[0-9a-f]{64}$/i.test(job.token ?? '')) return 'Invalid run token'
  if (!validModel(job.model)) return 'Invalid model'
  if (job.effort !== undefined && !EFFORTS.includes(job.effort)) return 'Invalid effort'
  if (typeof job.prompt !== 'string' || typeof job.system !== 'string') return 'Missing prompt'
  if (job.prompt.length + job.system.length > 1_000_000) return 'Task is too large'
  return ''
}

async function run(job) {
  const invalid = validate(job)
  if (invalid) return { success: false, text: invalid }
  const turns = Math.min(40, Math.max(1, Number.isInteger(job.maxTurns) ? job.maxTurns : 24))
  const dir = await mkdtemp(join(tmpdir(), 'doop-claude-'))
  try {
    const config = join(dir, 'mcp.json')
    const systemPath = join(dir, 'system.txt')
    const mcp = {
      mcpServers: {
        doop: {
          type: 'http',
          url: `${baseUrl}/local-agent/mcp/${job.id}`,
          headers: { Authorization: `Bearer ${job.token}` },
        },
      },
    }
    await writeFile(config, JSON.stringify(mcp), { mode: 0o600, flag: 'wx' })
    await writeFile(systemPath, job.system, { mode: 0o600, flag: 'wx' })
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--tools',
      '',
      '--allowedTools',
      'mcp__doop__*',
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
      '--max-turns',
      String(turns),
      '--settings',
      '{"disableAllHooks":true}',
      '--mcp-config',
      config,
      '--system-prompt-file',
      systemPath,
      ...(job.model !== 'default' ? ['--model', job.model] : []),
      ...(job.effort ? ['--effort', job.effort] : []),
    ]
    const env = { ...process.env }
    for (const key of STRIPPED_ENV) delete env[key]
    const child = spawn(claudeBin, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] })
    if (active?.id === job.id) active.child = child
    child.stdin.end(job.prompt)

    let result = null
    let failure = ''
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line.length > MAX_LINE_BYTES) {
        failure = 'Claude output exceeded the 2 MB line limit. The run was stopped; retry with a smaller tool result.'
        child.kill()
        return
      }
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'result') {
        result = {
          success: event.is_error === false && event.subtype === 'success',
          text:
            typeof event.result === 'string'
              ? event.result
              : 'Claude did not complete the task. Check your login and usage limits, then retry.',
        }
      }
    })
    const timer = setTimeout(() => {
      failure = 'Claude run stopped or timed out. Retry when ready.'
      child.kill()
    }, RUN_TIMEOUT_MS)
    const code = await new Promise((resolve) => {
      child.on('error', (error) => {
        failure = `Could not start ${claudeBin}: ${error.message}`
        resolve(-1)
      })
      child.on('close', resolve)
    })
    clearTimeout(timer)
    if (active?.stopped) return { success: false, text: 'Claude run stopped or timed out. Retry when ready.' }
    if (failure) return { success: false, text: failure }
    if (!result)
      return { success: false, text: 'Claude exited without a result. Check your CLI login and version, then retry.' }
    return code === 0 ? result : { ...result, success: false }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function launch(job) {
  active = { id: job.id, stopped: false }
  log(`run ${job.id} started (model ${job.model}${job.effort ? `, effort ${job.effort}` : ''})`)
  void run(job)
    .catch((error) => ({ success: false, text: String(error) }))
    .then((result) => {
      log(`run ${job.id} ${result.success ? 'finished' : `failed: ${result.text.slice(0, 200)}`}`)
      completed = { id: job.id, result: { ...result, text: result.text.slice(0, 100_000) } }
    })
}

function stop(reason) {
  if (!active || active.stopped) return
  log(`run ${active.id} stopped: ${reason}`)
  active.stopped = true
  active.child?.kill()
}

let polling = false
async function tick() {
  if (polling) return
  polling = true
  try {
    if (completed) {
      await call(`/finish/${completed.id}`, { deviceId, ...completed.result })
      completed = null
      active = null
    }
    const { job, enabled } = await call('/poll', { deviceId })
    if (active && !completed && (!enabled || !job || job.id !== active.id)) stop('canceled on the server')
    else if (job && !active) launch(job)
    if (lastError) log('reconnected')
    lastError = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastError) log(`poll failed: ${message}`)
    lastError = message
  } finally {
    polling = false
  }
}

const status = await call('').catch((error) => {
  console.error(`Cannot reach ${baseUrl}: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
log(
  `polling ${baseUrl} as device ${deviceId}; Claude Plan is ${status.enabled ? 'on' : 'off (turn it on in Settings → Doop Agent)'}`,
)
void tick()
const timer = setInterval(() => void tick(), POLL_MS)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer)
    stop('runner shutting down')
    setTimeout(() => process.exit(0), 500)
  })
