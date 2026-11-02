// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = { preference: { enabled: false, model: 'sonnet', online: true }, native: null }
const setLocalAgent = vi.fn().mockResolvedValue({})
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({ api: { setLocalAgent: (...args: unknown[]) => setLocalAgent(...args) } }))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: () => {} }) } }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false }))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: (select?: (s: typeof state) => unknown) => (select ? select(state) : state),
  hasLocalClaude: () => false,
  canInstallClaude: () => false,
  canChooseClaude: () => false,
  refreshLocalAgent: vi.fn().mockResolvedValue({ native: null }),
  selectLocalAgent: vi.fn(),
  disconnectLocalAgent: vi.fn(),
  invokeClaude: vi.fn(),
}))
import { LocalClaudeRow } from '../src/components/LocalClaude'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<LocalClaudeRow />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
it('lets a browser switch the plan on while a headless runner polls for the account', async () => {
  expect(container.textContent).toContain('Headless runner')
  const use = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use instead')!
  await act(async () => use.click())
  expect(setLocalAgent).toHaveBeenCalledWith({ enabled: true, model: 'sonnet' })
})
