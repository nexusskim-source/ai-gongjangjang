// 망고빙수 포스터 보기용 정적 서버
// 실행: node server.js
//   일러스트 포스터 → http://localhost:3007/
//   포토 포스터     → http://localhost:3007/poster-photo.html
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3007;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];
    const file = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
    const full = path.join(__dirname, file);
    if (!full.startsWith(__dirname)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('없는 파일입니다: ' + file);
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`망고빙수 포스터: http://localhost:${PORT}`));
