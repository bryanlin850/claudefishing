// Prepare metadata only. Validation, tests, commit, tag and publication are separate steps.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: node scripts/prepare-release.mjs MAJOR.MINOR.PATCH')
const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const writeJson = (path, value) => writeFileSync(new URL(path, root), `${JSON.stringify(value, null, 2)}\n`)
for (const path of ['.claude-plugin/plugin.json', 'package.json']) {
  writeJson(path, { ...JSON.parse(read(path)), version })
}
const versionSource = read('types/version.ts')
if ((versionSource.match(/const MOD_VERSION = '[^']+'/g) ?? []).length !== 1) throw new Error('Expected one MOD_VERSION declaration')
writeFileSync(new URL('types/version.ts', root), versionSource.replace(/const MOD_VERSION = '[^']+'/, `const MOD_VERSION = '${version}'`))
const lock = JSON.parse(read('package-lock.json'))
lock.version = version
lock.packages[''].version = version
writeJson('package-lock.json', lock)
writeJson('release.json', {
  version,
  updateCommand: 'claude plugin marketplace update claudefishing && claude plugin update claudefishing@claudefishing',
  contract: { path: 'types/protocol.ts', sha256: createHash('sha256').update(read('types/protocol.ts')).digest('hex') },
})
console.log(`Prepared ${version}. Run npm run validate, npm test and npm run typecheck before publishing.`)
