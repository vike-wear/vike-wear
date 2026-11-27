import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import postcss from 'postcss'
import fs from 'node:fs'
import path from 'node:path'

// An app's code reads only its own files and its packages (2026-10-30; every
// way in, 2026-11-01). Its preview and builds run on our servers, and Vite puts
// a file it reads into the page — or the first line of it into the error it
// prints. The app's folder and its node_modules (a symlink to the shared
// install) are the only places. Vite reads a file four ways, each fenced:
//   - a module id (?raw, ?url, import.meta.glob, …): load
//   - a stylesheet's @import, and the sheets it imports: transform (they are
//     read straight from disk, in the preview and in every build)
//   - a file a build turns into an asset URL (url(), image-set(),
//     new URL('…', import.meta.url)): build.assetsInlineLimit sees it first
//   - a Web Worker, bundled on its own: worker.plugins
// scripts/_test-stylesheet-config.ts §6–§7.
const realPath = (p) => { try { return fs.realpathSync(p) } catch { return null } }
const fence = { root: '', publicDir: '', roots: [] }

function fenceRoot(root, publicDir) {
  fence.root = root
  fence.publicDir = publicDir || path.join(root, 'public')
  fence.roots = [realPath(root), realPath(path.join(root, 'node_modules'))].filter(Boolean)
}

/** Why the app's code may not read `file`, or null when it may (or it is no file at all). */
function outsideApp(file) {
  const resolved = realPath(file)
  if (!resolved) return null // not a file on disk: a virtual module, or Vite's own error to give
  if (!fence.roots.length) fenceRoot(process.cwd())
  if (fence.roots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) return null
  return `${file} is outside this app — an app's code can only import its own files and its packages.`
}

// What postcss-import leaves alone (a URL the browser fetches) — its own test.
const IMPORT_URL = /^(?:[a-z]+:)?\/\//i

/** The targets of a stylesheet's @import rules. */
function importTargets(code, from) {
  let sheet
  try { sheet = postcss.parse(code, { from }) } catch { return [] } // a sheet PostCSS can't parse imports nothing
  const targets = []
  sheet.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== 'import') return
    const params = rule.params.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    const m = /^url\(\s*(['"]?)([\s\S]*?)\1\s*\)/i.exec(params) || /^(['"])([\s\S]*?)\1/.exec(params)
    targets.push(m ? m[2] : params.split(/[\s;]/)[0])
  })
  return targets
}

/** Every file an @import of `target` from `fromFile` could load (postcss-import + Vite's resolver). */
function importCandidates(target, fromFile) {
  const files = []
  const variants = new Set([target])
  try { variants.add(decodeURIComponent(target)) } catch { /* not percent-encoded */ }
  for (const variant of variants) {
    const bare = variant.split(/[?#]/)[0]
    if (!bare) continue
    const bases = bare.startsWith('/')
      ? [path.join(fence.root, bare), path.join(fence.publicDir, bare), bare]
      : [path.resolve(path.dirname(fromFile), bare), path.join(fence.root, 'node_modules', bare)]
    for (const base of bases) files.push(base, `${base}.css`, path.join(base, 'index.css'))
  }
  return files
}

/** Why an @import in `code` — or in a sheet it imports, at any depth — may not load, or null. */
function outsideImport(code, fromFile, seen) {
  for (const target of importTargets(code, fromFile)) {
    if (IMPORT_URL.test(target) || /^data:/i.test(target)) continue
    if (/[\\\0]/.test(target)) return `${target} is not a file of this app — an app's code can only import its own files and its packages.`
    for (const file of importCandidates(target, fromFile)) {
      let isFile = false
      try { isFile = fs.statSync(file).isFile() } catch { /* not there */ }
      if (!isFile) continue
      const why = outsideApp(file)
      if (why) return why
      const resolved = realPath(file)
      if (!resolved || seen.has(resolved) || resolved.includes(`${path.sep}node_modules${path.sep}`) || seen.size > 200) continue
      seen.add(resolved)
      let nested = ''
      try { nested = fs.readFileSync(resolved, 'utf8') } catch { continue }
      const deeper = nested.includes('@import') ? outsideImport(nested, resolved, seen) : null
      if (deeper) return deeper
    }
  }
  return null
}

function stayInsideApp() {
  return {
    name: 'whacka-stay-inside-app',
    enforce: 'pre',
    configResolved(config) {
      fenceRoot(config.root, config.publicDir)
    },
    load(id) {
      if (!id || id.startsWith('\0')) return null
      const file = id.split('?')[0].split('#')[0]
      if (!path.isAbsolute(file)) return null
      const why = outsideApp(file)
      if (why) this.error(why)
      return null
    },
    transform(code, id) {
      if (!id || id.startsWith('\0')) return null
      const file = id.split('?')[0].split('#')[0]
      if (!/\.(css|pcss|postcss)$/i.test(file) || !path.isAbsolute(file) || !code.includes('@import')) return null
      const why = outsideImport(code, file, new Set())
      if (why) this.error(why)
      return null
    },
  }
}

/** build.assetsInlineLimit: Vite asks it about every file it turns into an asset URL — the fence, then Vite's own 4 KB rule. */
function assetInsideApp(file) {
  const why = outsideApp(file)
  if (why) throw new Error(why)
  return undefined
}

// Rewrites `import { MaybeInvalid } from 'lucide-react'` into a namespace
// import with per-icon fallback so AI-hallucinated icon names don't crash the app.
function lucideSafeImport() {
  return {
    name: 'lucide-safe-import',
    transform(code, id) {
      if (!/\.[jt]sx?$/.test(id) || id.includes('node_modules')) return
      const re = /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]lucide-react['"]/g
      if (!re.test(code)) return
      re.lastIndex = 0

      const bindings = []
      const cleaned = code.replace(re, (_, nameList) => {
        for (const raw of nameList.split(',')) {
          const trimmed = raw.trim()
          if (!trimmed) continue
          const [orig, alias] = trimmed.split(/\s+as\s+/).map(s => s.trim())
          bindings.push({ orig, alias: alias || orig })
        }
        return ''
      })

      if (!bindings.length) return
      const header = `import * as __lucide from 'lucide-react';\n` +
        bindings.map(b => `const ${b.alias} = __lucide["${b.orig}"] || __lucide.Circle;`).join('\n') + '\n'
      return { code: header + cleaned, map: null }
    },
  }
}

// Auto-injects missing React hook imports in AI-generated code.
// Same defensive pattern as lucideSafeImport — if the AI writes useRef()
// but forgets to add it to the import statement, this plugin patches it at build time.
// A name the file binds itself (its own `const memo`, `function useId`, an import
// from another file) is left alone: React's import next to it would declare the
// name twice and fail the build (P5 follow-up, 2026-10-18).
function reactHooksAutoImport() {
  const HOOKS = [
    'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo',
    'useContext', 'useReducer', 'useLayoutEffect', 'useId',
    'useTransition', 'useDeferredValue', 'useImperativeHandle',
    'useInsertionEffect', 'useSyncExternalStore', 'useDebugValue',
    'memo', 'forwardRef', 'createContext', 'lazy', 'Suspense',
  ]
  const HOOK_CALL = HOOKS.map(h => `\\b${h}\\b`).join('|')
  const HOOK_RE = new RegExp(HOOK_CALL, 'g')

  // Names declared or imported at the module's top level. Empty when the code
  // does not parse here — then every missing name is imported, as before.
  function moduleBindings(ctx, code) {
    const names = new Set()
    let ast
    try { ast = ctx.parse(code) } catch { return names }
    const bind = (p) => {
      if (!p) return
      if (p.type === 'Identifier') names.add(p.name)
      else if (p.type === 'ObjectPattern') p.properties.forEach(q => bind(q.type === 'RestElement' ? q.argument : q.value))
      else if (p.type === 'ArrayPattern') p.elements.forEach(bind)
      else if (p.type === 'AssignmentPattern') bind(p.left)
      else if (p.type === 'RestElement') bind(p.argument)
    }
    for (let node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        for (const s of node.specifiers) names.add(s.local.name)
        continue
      }
      if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && node.declaration) node = node.declaration
      if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) names.add(node.id.name)
      else if (node.type === 'VariableDeclaration') for (const d of node.declarations) bind(d.id)
    }
    return names
  }

  return {
    name: 'react-hooks-auto-import',
    transform(code, id) {
      if (!/\.[jt]sx?$/.test(id) || id.includes('node_modules')) return

      const used = new Set()
      for (const m of code.matchAll(HOOK_RE)) used.add(m[0])
      if (!used.size) return

      const importRe = /import\s+(?:(\w+)\s*,\s*)?\{\s*([^}]*)\}\s*from\s*['"]react['"]/
      const importReG = new RegExp(importRe.source, 'g')
      const defaultImportRe = /import\s+(\w+)\s+from\s*['"]react['"]/

      const allMatches = [...code.matchAll(importReG)]
      const firstMatch = allMatches[0] || null
      const defaultMatch = !firstMatch && code.match(defaultImportRe)

      const alreadyImported = new Set()
      for (const m of allMatches) {
        for (const name of m[2].split(',')) {
          const t = name.replace(/\s+as\s+\w+/, '').trim()
          if (t) alreadyImported.add(t)
        }
      }

      let missing = [...used].filter(h => !alreadyImported.has(h))
      if (!missing.length) return
      const own = moduleBindings(this, code)
      missing = missing.filter(h => !own.has(h))
      if (!missing.length) return

      if (firstMatch) {
        const firstNames = new Set()
        for (const name of firstMatch[2].split(',')) {
          const t = name.replace(/\s+as\s+\w+/, '').trim()
          if (t) firstNames.add(t)
        }
        const merged = [...new Set([...firstNames, ...missing])]
        const defaultPart = firstMatch[1] ? `${firstMatch[1]}, ` : ''
        const newImport = `import ${defaultPart}{ ${merged.join(', ')} } from 'react'`
        return { code: code.replace(importRe, newImport), map: null }
      }

      if (defaultMatch) {
        const newImport = `import ${defaultMatch[1]}, { ${missing.join(', ')} } from 'react'`
        return { code: code.replace(defaultImportRe, newImport), map: null }
      }

      // No react import at all — add one
      return { code: `import { ${missing.join(', ')} } from 'react';\n` + code, map: null }
    },
  }
}

export default defineConfig({
  plugins: [stayInsideApp(), reactHooksAutoImport(), lucideSafeImport(), react()],
  build: {
    assetsInlineLimit: assetInsideApp,
  },
  worker: {
    plugins: () => [stayInsideApp()],
  },
  base: process.env.VITE_BASE || '/',
  cacheDir: './.vite',
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    host: true,
    // allowedHosts stays Vite's default (this box's addresses and localhost): the
    // proxy and the checks ask 127.0.0.1, and a public name that resolves here gets
    // no answer (delivery ledger P106, docs/claude-md/rooms.md).
    hmr: false,
    // Everything that loads a preview is same-origin with its vite (the editor
    // through the proxy, the checks directly). Vite's default answers every
    // loopback origin, and a check loads an app ON loopback, so one app's page
    // could read another app's source off this box (2026-11-01,
    // docs/claude-md/browser-fence.md).
    cors: false,
  },
  // Pre-bundle ALL libraries that generated code may import.
  // Without this, Vite discovers new imports at runtime, triggers re-optimization,
  // and invalidates existing chunks — causing 404s in the browser.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      'lucide-react',
      'date-fns',
      'date-fns/locale',
      'phaser',
      'three', // games track (2026-09-08): GameCanvas3D imports it — discovered at runtime it would re-optimize and 404 the first preview
      'leaflet',
      'react-leaflet',
      'qrcode.react',
      '@supabase/supabase-js',
      'html-to-image', // a template dependency since print.send (2026-10-15), so an app may import it; print.send itself draws with its copy in src/lib/_html-to-image (2026-10-27)
    ],
  },
})
