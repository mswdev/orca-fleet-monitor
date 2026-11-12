// Serves this repository on 127.0.0.1 so the panel preview (tools/preview/) can load the panel's
// ES modules, which browsers refuse to load from file:// URLs. Node built-ins only.
//
//   node tools/preview-server.mjs [--port 4173]
//   then open http://127.0.0.1:4173/tools/preview/
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

/** Starts the server; resolves with its address. Port 0 picks a free one. */
export function startPreviewServer(port = 4173) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      let file = path.resolve(ROOT, `.${decodeURIComponent(url.pathname)}`)
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        response.writeHead(403).end()
        return
      }
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
      const type = TYPES[path.extname(file)]
      if (!type || file.split(path.sep).some((part) => part === 'node_modules' || part === '.git')) {
        response.writeHead(404).end()
        return
      }
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch {
      response.writeHead(404).end()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}` })
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port')
  const port = index > 0 ? Number(process.argv[index + 1]) : 4173
  const { url } = await startPreviewServer(Number.isFinite(port) ? port : 4173)
  console.log(`Fleet Monitor preview: ${url}/tools/preview/`)
  console.log(`Listing layout:        ${url}/tools/preview/listing.html (and ?theme=dark)`)
  console.log('Ctrl-C to stop.')
}
