#!/usr/bin/env node
/**
 * Repository checks for dsh-cleaner.
 *
 * Dependency-free on purpose: the bundle itself imports nothing but `node:` builtins and its own
 * files, and CI should not need an install step to check that. What this proves:
 *
 *   1. the bundle manifest parses, every path it publishes exists, and every root module is published;
 *   2. a Host module imports no `@deepseek-ai` package and no bare specifier at all, and the entry
 *      exports the plugin face;
 *   3. every tool wrapper declares `(args, exec)` and no tool schema uses a keyword the Host refuses
 *      (it does not fail one tool: it fails the plugin at load);
 *   4. locale/en.json and locale/zh.json carry the same keys, and the Chinese title is the family's
 *      two-character name;
 *   5. the bundle patch is a top-level array and its insert names this package;
 *   6. the version in the manifest is a section in CHANGELOG.md and the version the README states;
 *   7. the document set is complete and every citation resolves: a document is classified as a pair or
 *      as a declared single-language file, every `docs/…md` that is named exists, every document is
 *      linked from the README, and a `§N` points at a heading;
 *   8. no shared document carries an absolute machine path.
 *
 * What it cannot prove: that the plugin activates, that either tool behaves, or that a deletion was
 * correct. That needs a profile install and a live call, which is the person's decision every time.
 *
 * The YAML reader below understands only the subset this repository's patch uses. It is a structural
 * check of a known file, not a YAML parser; a construct it does not understand is reported, never
 * silently accepted.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (message) => failures.push(message)

const read = (relative) => {
  const absolute = join(root, relative)
  if (!existsSync(absolute)) {
    fail(`${relative}: missing`)
    return undefined
  }
  return readFileSync(absolute, 'utf8')
}

const readJson = (relative) => {
  const text = read(relative)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${relative}: invalid JSON (${error.message})`)
    return undefined
  }
}

// 1. Manifest and published files.
const manifest = readJson('package.json')
let pluginName
let pluginVersion
if (manifest !== undefined) {
  pluginName = manifest.name
  pluginVersion = manifest.version
  // Either a bare npm name or a scoped one; the bundle id and the patch row must agree with it.
  if (typeof pluginName !== 'string' || !/^(?:@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/.test(pluginName)) {
    fail('package.json: name must be a lowercase npm package name')
  }
  if (typeof pluginVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(pluginVersion)) {
    fail('package.json: version must be a plain semver string')
  }
  if (manifest.type !== 'module') fail('package.json: type must be "module"')
  const patch = manifest.dsh?.bundle?.patch
  if (patch !== './cordis.patch.yml') fail('package.json: dsh.bundle.patch must point at ./cordis.patch.yml')
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) {
      const directory = join(root, dirname(entry))
      const pattern = entry.slice(entry.lastIndexOf('/') + 1)
      const suffix = pattern.replace('*', '')
      const matches = existsSync(directory)
        ? readdirSync(directory).filter((name) => name.endsWith(suffix))
        : []
      if (matches.length === 0) fail(`package.json: files entry "${entry}" matches nothing`)
      continue
    }
    if (!existsSync(join(root, entry))) fail(`package.json: files entry "${entry}" does not exist`)
  }
  // Zero-dependency and no build step are the design, not an oversight (ADR 0002).
  if (manifest.dependencies !== undefined || manifest.devDependencies !== undefined) {
    fail('package.json: declares dependencies; a profile-linked bundle cannot resolve them')
  }
  const forbiddenScripts = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly', 'build']
  for (const script of forbiddenScripts) {
    if (manifest.scripts?.[script] !== undefined) fail(`package.json: scripts.${script} implies an install or build step`)
  }
  for (const required of ['index.js', 'engine.js']) {
    if (!(manifest.files ?? []).some((entry) => entry === required)) fail(`package.json: files must include ${required}`)
  }
  // The browser half is declared in the manifest, published, importable, and registered under the package
  // name: the page's loader finds it by the id in that call, so a mismatch would load nothing at all.
  const client = manifest.dsh?.client
  if (client !== undefined) {
    if (client.platform !== 'web') fail('package.json: dsh.client.platform must be "web"')
    if (client.immediately !== true) fail('package.json: dsh.client.immediately must be true, so a row is gone on the next load')
    if (!Array.isArray(client.inject) || client.inject.length === 0) {
      fail('package.json: dsh.client.inject must name the client package that serves the session list')
    }
    if (manifest.exports?.['./client'] !== './client.js') fail('package.json: exports["./client"] must point at ./client.js')
    if (!(manifest.files ?? []).includes('client.js')) fail('package.json: files must include client.js')
    const half = read('client.js')
    if (half !== undefined) {
      if (!half.includes('window.__ModuleLoader__.load(')) fail('client.js: must register through window.__ModuleLoader__.load')
      if (!half.includes(`id: '${pluginName}'`)) fail(`client.js: the registered id must be the package name (${pluginName})`)
      if (/\brequire\s*\(\s*['"]/.test(half)) fail('client.js: imports a module; the browser half depends on nothing')
    }
  }
  // The published set is the bundle, not the repository: tests, documents and the gate are for whoever
  // works here, and shipping them in the tarball would be a silent expansion of what a profile installs.
  for (const entry of manifest.files ?? []) {
    const top = entry.split('/')[0]
    if (['tests', 'docs', 'scripts', '.github'].includes(top)) {
      fail(`package.json: files must not publish "${entry}"; the bundle ships what the Host needs, not CI`)
    }
  }
}

// 2. Host half: no Harness import, no bare specifier, and the entry exports the plugin face.
//    The module list is derived from the repository, so a new module cannot escape the scan by not
//    being listed. Syntax is checked by `node --check` in CI, not here.
const hostModules = readdirSync(root).filter((name) => name.endsWith('.js')).sort()
const publishedFiles = new Set((manifest?.files ?? []).map((entry) => entry.replace(/^\.\//, '')))
if (!hostModules.includes('index.js')) fail('index.js: missing from the repository root')
for (const module of hostModules) {
  const text = read(module)
  if (text === undefined) continue
  if (!publishedFiles.has(module)) fail(`package.json: files must include "${module}"`)
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const specifier = match[1]
    if (specifier.startsWith('@deepseek-ai/')) {
      fail(`${module}: imports ${specifier}; a profile-linked bundle cannot resolve it (ADR 0002)`)
    } else if (!specifier.startsWith('node:') && !specifier.startsWith('.')) {
      fail(`${module}: imports the bare specifier "${specifier}"; only node: builtins and relative files resolve`)
    }
  }
  if (/(?:^|\n)\s*(?:const|let|var)\s+[^=\n]+=\s*await\s+import\(/.test(text)) {
    fail(`${module}: uses a dynamic import; keep the dependency surface static`)
  }
}
const entry = read('index.js')
if (entry !== undefined && !/export\s+(async\s+)?function\s+apply\s*\(/.test(entry)) {
  fail('index.js: must export apply(ctx)')
}
// Every tool wrapper takes the host execution context: the guard that refuses to delete the running
// session reads `exec.agent`, and a signature without it is a ReferenceError only when the model
// calls the tool.
for (const match of entry?.matchAll(/async\s+execute\s*\(([^)]*)\)/g) ?? []) {
  const parameters = match[1].split(',').map((name) => name.trim())
  if (!parameters.includes('exec')) {
    fail(`index.js: every execute must declare (args, exec); found (${match[1].trim()})`)
  }
}

// The registered names are a derived registry: whatever the entry registers — a tool or a human command —
// the README pair must name. A renamed surface otherwise leaves the primary document describing something
// that no longer exists.
const registeredNames = [...(entry?.matchAll(/name:\s*'([a-z][a-z0-9_]+)'/g) ?? [])].map((match) => match[1])
if (entry !== undefined && registeredNames.length === 0) fail('index.js: no tool definition found')
for (const name of registeredNames) {
  for (const document of ['README.md', 'README-zh.md']) {
    const text = read(document)
    if (text !== undefined && !text.includes(`\`${name}\``)) {
      fail(`${document}: does not name "${name}", which index.js registers`)
    }
  }
}

// A tool schema is validated by the Host, and a keyword outside its accepted subset does not fail one
// tool: it fails the plugin. The accepted subset is type/oneOf/properties/required/
// additionalProperties/items/enum/const plus annotations.
const FORBIDDEN_SCHEMA_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'pattern',
  'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'default',
  'examples', 'allOf', 'anyOf', 'not', '$ref', 'definitions', '$defs',
]
const entryLines = entry?.split(/\r?\n/) ?? []
for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
  const pattern = new RegExp(`(^|[{,\\s])${keyword.replace('$', '\\$')}\\s*:`)
  const at = entryLines.findIndex((text) => pattern.test(text))
  if (at !== -1) {
    fail(`index.js:${at + 1}: "${keyword}" is not in the schema subset the Host validates; the plugin will not activate`)
  }
}

// 3. Locale parity.
const keysOf = (value, prefix = '') => Object.entries(value ?? {})
  .flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? keysOf(child, path)
      : [path]
  })
  .sort()
const en = readJson('locale/en.json')
const zh = readJson('locale/zh.json')
if (en !== undefined && zh !== undefined) {
  const enKeys = keysOf(en)
  const zhKeys = keysOf(zh)
  for (const key of enKeys.filter((key) => !zhKeys.includes(key))) fail(`locale/zh.json: missing key "${key}"`)
  for (const key of zhKeys.filter((key) => !enKeys.includes(key))) fail(`locale/en.json: missing key "${key}"`)
  if (typeof en.meta?.title !== 'string' || en.meta.title.length === 0) fail('locale/en.json: meta.title is required')
  if (typeof en.meta?.description !== 'string' || en.meta.description.length === 0) {
    fail('locale/en.json: meta.description is required')
  }
  // The family convention: the Chinese title is two characters, as in the team and memory bundles.
  if (typeof zh.meta?.title !== 'string' || [...zh.meta.title].length !== 2) {
    fail('locale/zh.json: meta.title must be the two-character name of the family convention')
  }
}

// 4. Bundle patch: a top-level array whose insert names this package.
const patchText = read('cordis.patch.yml')
if (patchText !== undefined) {
  const lines = patchText.split(/\r?\n/)
  if (lines.some((line) => line.includes('\t'))) fail('cordis.patch.yml: tabs are not allowed')
  const body = lines.filter((line) => !/^\s*#/.test(line) && line.trim() !== '')
  if (!body.some((line) => /^-\s/.test(line))) fail('cordis.patch.yml: must be a top-level array of patch entries')
  const insertAt = body.findIndex((line) => /^-\s+insert:\s*$/.test(line))
  if (insertAt === -1) {
    fail('cordis.patch.yml: expected an insert entry for this bundle')
  } else {
    const inserted = body.slice(insertAt + 1).join('\n')
    if (pluginName !== undefined && !inserted.includes(`name: '${pluginName}'`) && !inserted.includes(`name: "${pluginName}"`)) {
      fail(`cordis.patch.yml: insert must name ${pluginName}`)
    }
  }
}

// 5. The version is one fact in three places: manifest, changelog, README status.
const changelog = read('CHANGELOG.md')
if (changelog !== undefined && pluginVersion !== undefined) {
  if (!changelog.includes(`## [${pluginVersion}]`)) {
    fail(`CHANGELOG.md: no section for version ${pluginVersion}`)
  }
  const readme = read('README.md')
  if (readme !== undefined && !readme.includes(`Current version: v${pluginVersion}`)) {
    fail(`README.md: "Current version" must state v${pluginVersion}`)
  }
}

// 6. The document set.
//
// Every file at the top level of docs/ is classified by one of four shapes, and one the rule cannot
// classify fails by name:
//
//   docs/name-en.md + docs/name-zh.md   a bilingual pair; either half missing fails by name
//   docs/name-en-zh.md                  both languages in ONE file; proven by content, not by name
//   docs/name.md                        single-language, and listed in SINGLE_LANGUAGE_DOCS with the
//                                       one-line reason it is deliberately one language
//   docs/adr/NN-name.md                 out of scope: a decision is English-only and numbered
//
// This repository has no pairs under docs/ today; the rule is here so that adding one cannot silently
// leave it half-written, and the declaration list is what keeps the deliberate exception visible.
const SINGLE_LANGUAGE_DOCS = new Map([
  [
    'design.md',
    'the maintainer-facing account of the mechanism; the user-facing translation is README-zh.md, and a '
    + 'second copy of the state matrix would be a second thing to keep in step',
  ],
])
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_WORD = /[A-Za-z]{4,}/
const docsDir = join(root, 'docs')
const docNames = readdirSync(docsDir).filter((name) => name.endsWith('.md')).sort()
const docSet = new Set(docNames)
for (const name of docNames) {
  if (name.endsWith('-en-zh.md')) {
    const text = readFileSync(join(docsDir, name), 'utf8')
    if (!CJK.test(text)) fail(`docs/${name}: carries both languages by name but no Chinese text by content`)
    if (!LATIN_WORD.test(text)) fail(`docs/${name}: carries both languages by name but no English prose by content`)
    continue
  }
  if (name.endsWith('-en.md')) {
    const wanted = `${name.slice(0, -'-en.md'.length)}-zh.md`
    if (!docSet.has(wanted)) fail(`docs/${name}: has no docs/${wanted} (bilingual pair)`)
    continue
  }
  if (name.endsWith('-zh.md')) {
    const wanted = `${name.slice(0, -'-zh.md'.length)}-en.md`
    if (!docSet.has(wanted)) fail(`docs/${name}: has no docs/${wanted} (bilingual pair)`)
    continue
  }
  if (!SINGLE_LANGUAGE_DOCS.has(name)) {
    fail(
      `docs/${name}: single-language document with no declaration; add the -en/-zh pair, or list it in `
      + 'SINGLE_LANGUAGE_DOCS in scripts/check.mjs with the one-line reason it is deliberately one language',
    )
  }
}
for (const name of SINGLE_LANGUAGE_DOCS.keys()) {
  if (!docSet.has(name)) {
    fail(`docs/${name}: declared single-language in scripts/check.mjs but does not exist; remove the entry`)
  }
}

// Root documents: the README pair is checked by name because README.md carries no -en suffix, and the
// rest are single-language by policy (CONTRIBUTING §7).
for (const name of ['README.md', 'README-zh.md']) {
  if (!existsSync(join(root, name))) fail(`${name}: missing (bilingual pair)`)
}
const ROOT_SINGLE_LANGUAGE = ['AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE']
for (const name of ROOT_SINGLE_LANGUAGE) {
  if (!existsSync(join(root, name))) fail(`${name}: missing (single-language root document)`)
}

// An orphan document is a document nobody reads: every document under docs/ must be linked from the
// README's document table, and the link rule below proves the target exists in the other direction.
const adrNames = readdirSync(join(docsDir, 'adr')).filter((name) => name.endsWith('.md')).sort()
const readmeText = read('README.md') ?? ''
for (const relative of [
  ...docNames.map((name) => `docs/${name}`),
  ...adrNames.map((name) => `docs/adr/${name}`),
]) {
  if (!readmeText.includes(relative)) fail(`README.md: does not list ${relative}; an orphan document is unread`)
}

// 7. No machine-specific paths in shared documents.
const documents = [
  'README.md', 'README-zh.md', ...ROOT_SINGLE_LANGUAGE,
  ...docNames.map((name) => `docs/${name}`),
  ...adrNames.map((name) => `docs/adr/${name}`),
]
for (const document of documents) {
  const text = read(document)
  if (text === undefined) continue
  for (const line of text.split(/\r?\n/)) {
    // A drive-letter path, not a URL scheme: the character before `X:` must not be a word
    // character, so `https://host` does not trip the check while `C:\dir` and `(D:/dir)` do.
    if (/(?<![\w/])[A-Za-z]:[\\/]/.test(line)) {
      fail(`${document}: carries an absolute machine path: ${line.trim()}`)
    }
  }
}

// 8. In-repository references resolve.
//
// Two mechanical forms are checked:
//
//   - a document reference — `docs/<name>.md`, with or without -en/-zh, in prose or a link — must exist;
//   - a section reference — §N, §N.M — must resolve to a numbered heading in the document it points at.
//
// Which document a section reference points at, in this order:
//   1. the document the same citation names ("`docs/design.md` §4", "§4 of `docs/design.md`", a
//      continuation such as "§4.5 and §4.5.2", or a markdown link before the §);
//   2. for a bare §, the document it appears in, when that document has the heading;
//   3. otherwise the one English document at the top level of docs/ that has the heading, when exactly
//      one does — an ambiguous citation is reported, never resolved by picking one;
//   4. otherwise it fails.
//
// Root documents are checked as document references only: their numbering is prose ("CONTRIBUTING §7"
// is the seventh section of a document whose headings are unnumbered), so the heading test would call a
// correct citation wrong. CHANGELOG.md is history and is not a reference source.
const SECTION = '\\d+(?:\\.\\d+)*'
const headingCache = new Map()
const headingsOf = (relative) => {
  if (headingCache.has(relative)) return headingCache.get(relative)
  const text = existsSync(join(root, relative)) ? readFileSync(join(root, relative), 'utf8') : ''
  const numbers = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^#{1,6}\\s+(${SECTION})[.\\s]`).exec(line)
    if (match !== null) numbers.add(match[1])
  }
  headingCache.set(relative, numbers)
  return numbers
}
// Where the qualified forms live. A translated side repeats every number the English side has and
// would make every bare fallback ambiguous, so only the non-translated side is a target.
const sectionTargets = docNames.filter((name) => !name.endsWith('-zh.md')).map((name) => `docs/${name}`)
const referenceSources = [
  ...docNames.map((name) => `docs/${name}`),
  ...adrNames.map((name) => `docs/adr/${name}`),
  'README.md', 'README-zh.md', 'AGENTS.md', 'CONTRIBUTING.md',
  ...hostModules,
]
const DOCUMENT = '`?((?:docs/)?[A-Za-z0-9._/+-]+\\.md)(?::\\d+(?:-\\d+)?)?`?'
const qualifiedThenSection = new RegExp(`${DOCUMENT}\\s*[,;:]?\\s*§\\s*(${SECTION})`, 'g')
const sectionThenQualified = new RegExp(`§\\s*(${SECTION})\\s*(?:of|in)\\s+${DOCUMENT}`, 'g')
// The short form: the document's stem alone — "design §4". It counts only when docs/<stem>-en.md
// exists, so ordinary prose stays a bare reference instead of being read as a document nobody named.
const shortThenSection = new RegExp(`(?<![\\w/-])([a-z][a-z0-9-]*)\\s+§\\s*(${SECTION})`, 'g')
const linkThenSection = new RegExp(`\\[[^\\]]*\\]\\(([^)\\s]+\\.md)\\)\\s*[,;:]?\\s*§\\s*(${SECTION})`, 'g')
const anySection = new RegExp(`§\\s*(${SECTION})`, 'g')
const CONTINUES = /^[\s,;、/]*(?:and|or|与|和|及|或)?[\s,;、/]*$/
const resolveTarget = (token) => {
  const cleaned = token.replace(/:\d+(?:-\d+)?$/, '')
  if (cleaned.startsWith('docs/')) return cleaned
  return existsSync(join(root, 'docs', cleaned)) ? `docs/${cleaned}` : cleaned
}
const checkSection = (file, target, section) => {
  if (!existsSync(join(root, target))) {
    fail(`${file}: cites ${target} §${section}, but ${target} does not exist`)
    return
  }
  if (!target.startsWith('docs/')) return // a root document: its numbering is prose, not headings
  if (!headingsOf(target).has(section)) fail(`${file}: ${target} has no §${section}`)
}
for (const file of referenceSources) {
  const text = existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : ''
  for (const line of text.split(/\r?\n/)) {
    const qualified = []
    for (const match of line.matchAll(qualifiedThenSection)) {
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[2], target: resolveTarget(match[1]) })
    }
    for (const match of line.matchAll(sectionThenQualified)) {
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[1], target: resolveTarget(match[2]) })
    }
    for (const match of line.matchAll(shortThenSection)) {
      const stem = match[1]
      if (!existsSync(join(root, 'docs', `${stem}-en.md`))) continue
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[2], target: `docs/${stem}-en.md` })
    }
    for (const match of line.matchAll(linkThenSection)) {
      qualified.push({ start: match.index, end: match.index + match[0].length, section: match[2], target: resolveTarget(match[1]) })
    }
    for (const mark of qualified) checkSection(file, mark.target, mark.section)
    for (const match of line.matchAll(anySection)) {
      const at = match.index
      if (qualified.some((mark) => at >= mark.start && at < mark.end)) continue
      const section = match[1]
      const previous = qualified.filter((mark) => mark.end <= at).pop()
      if (previous !== undefined && CONTINUES.test(line.slice(previous.end, at))) {
        checkSection(file, previous.target, section)
        continue
      }
      if (headingsOf(file).has(section)) continue
      const owners = sectionTargets.filter((candidate) => headingsOf(candidate).has(section))
      if (owners.length === 1) continue
      if (owners.length === 0) {
        fail(`${file}: §${section} does not resolve — not a heading here, and no document under docs/ has it`)
      } else {
        fail(`${file}: §${section} is ambiguous — ${owners.join(' and ')} all have it; name the document`)
      }
    }
    // A document reference must exist, whether it is backticked prose or a markdown link. A token with a
    // capital in it is a pattern, not a citation — every real document is lowercase — which is what
    // keeps `docs/adr/NN-name.md` in a naming rule from being read as a missing file.
    for (const match of line.matchAll(/`(docs\/[A-Za-z0-9._/+-]+\.md)(?::\d+(?:-\d+)?)?`/g)) {
      if (/[A-Z]/.test(match[1])) continue
      if (!existsSync(join(root, match[1]))) fail(`${file}: cites ${match[1]}, which does not exist`)
    }
    for (const match of line.matchAll(/\]\(([^()\s]+\.md)\)/g)) {
      const target = match[1]
      if (target.startsWith('http')) continue
      const base = file.includes('/') ? `${file.slice(0, file.lastIndexOf('/'))}/` : ''
      if (!existsSync(join(root, base + target)) && !existsSync(join(root, target))) {
        fail(`${file}: links to ${base}${target}, which does not exist`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`check failed: ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('check passed')
