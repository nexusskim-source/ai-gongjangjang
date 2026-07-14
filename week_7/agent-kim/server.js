// 드라마 포스터 보기용 정적 서버
//   실행: node server.js
//   포스터 → http://localhost:3008/poster.html
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3008;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const rel = urlPath === "/" ? "/poster.html" : urlPath;
    const file = path.join(__dirname, rel);

    if (!file.startsWith(__dirname)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`포스터: http://localhost:${PORT}/poster.html`));
