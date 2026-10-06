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

        if (req.url === '/api/save-pair-fixture' && req.method === 'POST') {
          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const pairsDir = path.join(gtDir, 'pairs')
              if (!fs.existsSync(pairsDir)) {
                fs.mkdirSync(pairsDir, { recursive: true })
              }
              const filename = data.filename || `pair_gt_${Date.now()}.json`
              const filePath = path.join(pairsDir, filename)
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
            const pairsDir = path.join(gtDir, 'pairs')
            const pairFiles = fs.existsSync(pairsDir) ? fs.readdirSync(pairsDir).filter(f => f.endsWith('.json')) : []
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ count: files.length, files, pairCount: pairFiles.length, pairFiles }))
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

