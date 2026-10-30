import { actionName, validateExactTables } from './mt-api-client.js'

const TABLES_ACTION = '/api/v1/gametype/*/game/*/room/*/tables'

// Candidate-local, receive-only authority. Never replay the rolling diagnostic
// buffer: eviction must not lose auth, and replay must not undo revocation.
export function createApiCandidateCapture(context) {
  const pages = new WeakMap()
  context.on('page', (page) => {
    const state = { revoked: false, game: null, chat: null }
    pages.set(page, state)
    page.on('pageerror', () => { state.revoked = true })
    page.on('close', () => { state.revoked = true })
    page.on('websocket', (ws) => {
      const socket = { kind: null, tables: null }
      const revoke = () => { if (socket.kind) state.revoked = true }
      ws.on('close', revoke)
      ws.on('socketerror', revoke)
      ws.on('framereceived', ({ payload: raw }) => {
        if (state.revoked) return
        let payload
        try { payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) } catch { return }
        const action = actionName(payload)
        if (action === '/api/v1/member/logout'
          || (payload?.err != null && Number(payload.err) !== 0)) {
          state.revoked = true
          return
        }
        const kind = action === '/api/v1/authenticate' ? 'game'
          : action === '/api/v1/chat/authenticate' ? 'chat' : null
        if (kind) {
          // Sent requests, missing/null/boolean err and inferred table activity
          // are not explicit provider authentication acknowledgements.
          if (payload.err !== 0 && payload.err !== '0') return
          if (socket.kind && socket.kind !== kind) { state.revoked = true; return }
          socket.kind = kind
          socket.tables = null
          state[kind] = socket
          return
        }
        if (action === TABLES_ACTION && socket === state.game) {
          socket.tables = validateExactTables(payload?.msg?.tables)
        }
      })
    })
  })
  function snapshot(page) {
    const state = pages.get(page)
    const game = state?.game
    const authenticated = !state?.revoked && Boolean(game?.tables && state?.chat)
    return { connected: Boolean(state && !state.revoked), authenticated,
      tables: authenticated ? structuredClone(game.tables) : [] }
  }
  function admit(_snapshot, page) {
    const current = snapshot(page)
    return current.authenticated && current.tables.some(table => table.catalogMissing !== true)
  }
  return { snapshot, admit }
}
