import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildEnvTextWithToken, extractTokenFromMtUrl } from '../src/token-utils.js'
import { maskToken } from '../src/config.js'

const input = process.argv.slice(2).join(' ').trim()
if (!input) {
  console.error('請輸入 MT 網址或 token，例如：node scripts/update-token.mjs "https://gsa.ofalive99.net/?token=...&lang=zhtw"')
  process.exit(1)
}

const envPath = resolve(process.cwd(), '.env')
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const token = extractTokenFromMtUrl(input)
writeFileSync(envPath, buildEnvTextWithToken(existing, token), 'utf8')
console.log(`MT_TOKEN 已更新：${maskToken(token)}`)
console.log('如 PM2 常駐服務正在執行，請執行：pm2 restart draven-mt-proxy-v003 --update-env')
