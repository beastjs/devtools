import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

async function main() {
  if (pkg.name !== '@beastjs/devtools' || pkg.private || !stableVersion.test(pkg.version)) {
    throw new Error('Releases must publish the root @beastjs/devtools package with a stable version.')
  }
  const command = process.argv[2]
  if (command === 'verify') {
    const tag = process.argv[3]
    if (tag !== pkg.version) throw new Error(`Release tag ${JSON.stringify(tag)} does not match package.json version ${pkg.version}.`)
    console.log(`Verified ${pkg.name}@${pkg.version} against tag ${tag}.`)
  } else if (command === 'packed') {
    const result = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    const packages = Array.isArray(result) ? result : Object.values(result)
    const packed = packages[0]
    if (packages.length !== 1 || packed.name !== pkg.name || packed.version !== pkg.version) throw new Error('Expected only the root release package in npm pack output.')
    const files = new Set(packed.files.map((file) => file.path))
    const targets = (value) => typeof value === 'string' ? [value] : Object.values(value).flatMap(targets)
    for (const path of [...targets(pkg.exports), './client/devtools.css']) {
      if (!files.has(path.replace(/^\.\//, ''))) throw new Error(`Required package file is missing: ${path}`)
    }
    if (packed.files.some((file) => file.path.endsWith('.test.ts'))) throw new Error('Tests must not be included in the published package.')
    if (packed.filename !== `beastjs-devtools-${pkg.version}.tgz`) throw new Error('Unexpected npm package filename.')
    console.log(`filename=${packed.filename}`)
  } else if (command === 'published') {
    // Only a registry 404 means unpublished; auth and network failures stop the job.
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (response.status === 404) console.log('published=false')
    else {
      if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${pkg.name}@${pkg.version}.`)
      const version = await response.json()
      if (version.name !== pkg.name || version.version !== pkg.version) throw new Error('npm returned unexpected package metadata.')
      console.log('published=true')
    }
  } else throw new Error('Usage: node scripts/release.mjs verify <tag> | published | packed <npm-pack-json>')
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
