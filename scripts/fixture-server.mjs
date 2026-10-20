import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 4201;
const GT_DIR = path.resolve(__dirname, '../cv-engine/datasets/ground_truth');

if (!fs.existsSync(GT_DIR)) {
  fs.mkdirSync(GT_DIR, { recursive: true });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/ground-truth-count' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(GT_DIR).filter(f => f.endsWith('.json'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ count: files.length, files }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === '/api/save-ground-truth' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const filename = data.filename || `${data.id || `piece_gt_${Date.now()}`}.json`;
        const filePath = path.join(GT_DIR, filename);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        const files = fs.readdirSync(GT_DIR).filter(f => f.endsWith('.json'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, file: filename, count: files.length }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[fixture-server] Ground-truth API server running at http://localhost:${PORT}`);
  console.log(`[fixture-server] Storing fixtures in: ${GT_DIR}`);
});
