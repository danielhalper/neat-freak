// Optional offline QA fixture. The extension itself still has no build step.
// Wrap the actual ES modules in isolated scopes so a file:// page can run
// without a local server, external dependencies, or file-origin module access.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modules = ['src/utils.js', 'src/storage.js', 'src/categorizer.js', 'src/smart-scope.js', 'src/clutter-reminder.js', 'src/nudge-cycle.js', 'src/tidy-plan.js', 'src/recommendation-budget.js', 'src/recommendations.js', 'src/safe-close.js', 'src/diagnostics.js', 'src/behavior-log.js', 'tests/helpers/chrome-harness.js']
let script = ''
for (const relative of modules) {
	let source = fs.readFileSync(path.join(root, relative), 'utf8')
	const names = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)].map(match => match[1])
	source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/\bexport\s+/g, '')
	script += `const { ${names.join(', ')} } = (() => {\n${source}\nreturn { ${names.join(', ')} };\n})();\n`
}
const background = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
const panel = fs.readFileSync(path.join(root, 'src/neat-freak-panel.js'), 'utf8')
let harness = fs.readFileSync(path.join(root, 'tests/browser-harness.js'), 'utf8').replace(/^import[^\n]+\n/, '')
harness = harness.replace("const baseUrl = new URL('../', location.href).href", `const baseUrl = ${JSON.stringify(pathToFileURL(root + '/').href)}`)
harness = harness.replace("await import('../src/background.js')", `await (async () => {\n${background}\n})()`)
harness = harness.replace("await import('../src/neat-freak-panel.js')", `;\n${panel}\n;`)
script += `\n(async () => {\n${harness}\n})().catch(error => { document.getElementById('status').textContent = error.stack })`
let html = fs.readFileSync(path.join(root, 'tests/browser-harness.html'), 'utf8')
html = html.replace('<script type="module" src="./browser-harness.js"></script>', `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`)
const output = path.resolve(process.argv[2] || '/tmp/neat-freak-qa/browser.html')
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, html)
console.log(output)
