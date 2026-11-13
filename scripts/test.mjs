/**
 * Run the fixture tests with the isolation flag this Node major spells.
 *
 * The suites share one process on purpose: the default runner spawns one process per test file, and a
 * confined sandbox refuses that spawn. Node 24 calls the flag `--test-isolation`, while Node 22 documents
 * it as `--experimental-test-isolation`, so the spelling is chosen from the running version here instead
 * of being repeated in package.json, the CI matrix and the README — three copies that would drift.
 *
 * `npm test` is therefore the whole command, and it means the same thing on both majors CI claims.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const major = Number(process.versions.node.split('.')[0])
const isolation = major >= 24 ? '--test-isolation=none' : '--experimental-test-isolation=none'
const testsDir = new URL('../tests/', import.meta.url)

const files = (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `tests/${name}`)
if (files.length === 0) {
  console.error('no *.test.mjs files under tests/')
  process.exit(1)
}

const child = spawn(process.execPath, ['--test', isolation, ...files], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
})
child.on('exit', (code, signal) => process.exit(signal === null ? (code ?? 1) : 1))
