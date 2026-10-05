// Copy this plugin to an explicitly selected Claude Code dev-mods session.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const target = process.argv[2]
if (!target) throw new Error('Usage: npm run dev:sync -- /absolute/path/to/dev-mods/<session>')
const session = realpathSync(resolve(target))
if (!statSync(session).isDirectory()) throw new Error('The session directory must already exist')
const destination = join(session, 'claudefishing')
if (destination === root || root.startsWith(destination + sep) || destination.startsWith(root + sep)) {
  throw new Error('The dev copy must be outside the source checkout')
}
const marker = '.claudefishing-dev-copy'
if (existsSync(destination) && !existsSync(join(destination, marker))) {
  throw new Error(`Refusing to replace an unmanaged directory: ${destination}. Use a new session or --plugin-dir.`)
}
const serverUrl = new URL(process.env.SERVER_URL || 'http://localhost:8790')
if (!['http:', 'https:'].includes(serverUrl.protocol)) throw new Error('SERVER_URL must use http or https')
const stage = mkdtempSync(join(session, '.claudefishing-'))
try {
  for (const path of ['hooks', 'types', 'tests', 'tsconfig.json', 'README.md', '.claude-plugin/plugin.json']) {
    const output = join(stage, path)
    mkdirSync(dirname(output), { recursive: true })
    cpSync(join(root, path), output, { recursive: true })
  }
  const url = serverUrl.href.replace(/\/+$/, '')
  const manifestPath = join(stage, '.claude-plugin/plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.userConfig.serverUrl.default = url
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const hooksPath = join(stage, 'hooks/register.ts')
  const hooks = readFileSync(hooksPath, 'utf8')
  const declaration = "const DEFAULT_SERVER_URL = 'https://claudefishing.io'"
  if (hooks.split(declaration).length !== 2) throw new Error('Expected one default server URL declaration')
  writeFileSync(hooksPath, hooks.replace(declaration, `const DEFAULT_SERVER_URL = ${JSON.stringify(url)}`))
  writeFileSync(join(stage, marker), 'Created by claudefishing/scripts/sync-dev.mjs\n')
  if (existsSync(destination)) rmSync(destination, { recursive: true })
  renameSync(stage, destination)
  console.log(`Synced ${destination} (serverUrl ${url})`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
