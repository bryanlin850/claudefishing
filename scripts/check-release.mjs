import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'))
const release = JSON.parse(read('release.json'))
const runtimeVersion = /export const MOD_VERSION = '([^']+)'/.exec(read('types/version.ts'))?.[1]
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
assert.equal(manifest.name, 'claudefishing')
assert.equal(marketplace.name, 'claudefishing')
assert.deepEqual(marketplace.plugins, [{ name: 'claudefishing', source: './' }])
assert.equal(runtimeVersion, manifest.version)
assert.equal(JSON.parse(read('package.json')).version, manifest.version)
assert.equal(release.version, manifest.version)
assert.equal(release.updateCommand, 'claude plugin marketplace update claudefishing && claude plugin update claudefishing@claudefishing')
assert.equal(release.contract.path, 'types/protocol.ts')
assert.equal(release.contract.sha256, createHash('sha256').update(read(release.contract.path)).digest('hex'))
console.log(`Release ${manifest.version}: metadata and HTTP contract agree.`)
