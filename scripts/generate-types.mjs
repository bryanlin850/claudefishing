// Load a disposable copy without an account, a real identity, or a game connection.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'claudefishing-types-'))
try {
  const plugin = join(temporary, 'plugin')
  for (const path of ['.claude-plugin/plugin.json', 'hooks', 'types', 'tsconfig.json']) {
    const destination = join(plugin, path)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(root, path), destination, { recursive: true })
  }
  // A closed loopback port and no automatic open: the session reaches no game.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(temporary, 'config'),
    CLAUDEFISHING_HOME: join(temporary, 'identity'), CLAUDEFISHING_SERVER_URL: 'http://127.0.0.1:9',
    CLAUDEFISHING_AUTO_OPEN: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  for (const name of ['CLAUDE_CODE_PLUGIN_DIRS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[name]
  execFileSync(join(root, 'node_modules/.bin/claude'), ['--plugin-dir', plugin, '--no-session-persistence', '-p', '/fishing status'],
    { cwd: temporary, env, timeout: 30_000, stdio: 'pipe' })
  const generated = join(plugin, '.claude-plugin/types')
  if (!existsSync(join(generated, 'tsconfig.json'))) throw new Error('Claude Code did not generate mod types')
  cpSync(generated, join(root, '.claude-plugin/types'), { recursive: true })
  console.log('Generated Claude Code types from an isolated mod session.')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
