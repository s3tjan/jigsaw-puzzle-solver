import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import fs from 'fs'
import path from 'path'

function groundTruthApiPlugin(): Plugin {
  return {
    name: 'ground-truth-api',
    configureServer(server) {
      const gtDir = path.resolve(__dirname, '../cv-engine/datasets/ground_truth')
      if (!fs.existsSync(gtDir)) {
        fs.mkdirSync(gtDir, { recursive: true })
      }

      server.middlewares.use((req, res, next) => {
        if (req.url === '/api/save-ground-truth' && req.method === 'POST') {
          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const filename = data.filename || `piece_gt_${Date.now()}.json`
              const filePath = path.join(gtDir, filename)
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ success: true, file: filename }))
            } catch (err) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: String(err) }))
            }
          })
          return
        }

        if (req.url === '/api/ground-truth-count' && req.method === 'GET') {
          try {
            const files = fs.readdirSync(gtDir).filter(f => f.endsWith('.json'))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ count: files.length, files }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }

        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), groundTruthApiPlugin()],
})

