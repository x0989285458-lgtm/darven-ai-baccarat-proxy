const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i

export function extractTokenFromMtUrl(input) {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('MT token is required')

  if (TOKEN_PATTERN.test(value)) return value

  try {
    const url = new URL(value)
    const token = url.searchParams.get('token')?.trim()
    if (token && TOKEN_PATTERN.test(token)) return token
  } catch {
    // fall through to consistent error below
  }

  throw new Error('Cannot extract valid MT token from input')
}

export function buildEnvTextWithToken(existingText = '', token, defaults = {}) {
  const cleanToken = extractTokenFromMtUrl(token)
  const lines = String(existingText ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !/^\s*MT_TOKEN\s*=/.test(line))

  if (!lines.some((line) => /^\s*PORT\s*=/.test(line))) lines.unshift(`PORT=${defaults.PORT ?? '8787'}`)
  if (!lines.some((line) => /^\s*AUTO_CONNECT\s*=/.test(line))) lines.push(`AUTO_CONNECT=${defaults.AUTO_CONNECT ?? 'true'}`)
  if (!lines.some((line) => /^\s*MT_ORIGIN\s*=/.test(line))) lines.push(`MT_ORIGIN=${defaults.MT_ORIGIN ?? 'https://gsa.ofalive99.net'}`)

  lines.push(`MT_TOKEN=${cleanToken}`)
  return `${lines.join('\n')}\n`
}
