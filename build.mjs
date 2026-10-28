// Concatenate the two browser sources into the lazy-CJS bundle protocol the
// DSH client module loader expects (window.__ModuleLoader__.load). No bundler,
// no dependencies: src/ghost.js and src/main.js are plain scripts that run
// inside the factory scope, so `require` there resolves against the platform
// module table (react, react/jsx-runtime, ...).
import { readFileSync, writeFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const ghost = readFileSync(new URL('./src/ghost.js', import.meta.url), 'utf8')
const main = readFileSync(new URL('./src/main.js', import.meta.url), 'utf8')

const bundle = `// GENERATED FILE — edit src/ghost.js or src/main.js and run: node build.mjs
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageJson.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${ghost}
${main}
    return module.exports
  },
})
`

writeFileSync(new URL('./client.js', import.meta.url), bundle)
console.log('client.js written (' + bundle.length + ' bytes)')
