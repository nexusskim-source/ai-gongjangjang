/**
 * 로컬 실행용 서버 — 정적 파일 서빙 + API 라우팅(core.js 사용).
 * 실행: node server.js  →  http://localhost:8787
 * (Vercel 배포 시에는 api/[...path].js 가 같은 core.js 로직을 서버리스로 처리)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const core = require("./core.js");

const PORT = process.env.PORT || 8787;
const HERE = __dirname;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const P = u.searchParams;
  const json = (code, obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.writeHead(code); res.end(JSON.stringify(obj)); };
  const num = (v) => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
  const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  const p = u.pathname.replace(/^\/api/, "") || u.pathname; // /api/home == /home

  try {
    if (u.pathname === "/api/home") { const lat = num(P.get("lat")), lng = num(P.get("lng")); if (lat == null || lng == null) return json(400, { error: "위치가 필요해요." }); return json(200, await core.handleHome(lat, lng)); }
    if (u.pathname === "/api/nearby") { const lat = num(P.get("lat")), lng = num(P.get("lng")); if (lat == null || lng == null) return json(400, { error: "위치가 필요해요." }); return json(200, await core.handleNearby(lat, lng, (P.get("q") || "").trim(), P.get("open") === "1", P.get("parking") === "1", (P.get("cat") || "").trim())); }
    if (u.pathname === "/api/search") { const region = (P.get("region") || "").trim(); if (!region) return json(400, { error: "지역을 입력하세요." }); return json(200, await core.handleRegion(region, (P.get("q") || "").trim(), P.get("open") === "1", P.get("parking") === "1", (P.get("cat") || "").trim())); }
    if (u.pathname === "/api/iploc") { try { return json(200, await core.iploc(clientIp)); } catch (e) { return json(502, { error: e.message }); } }
    if (u.pathname === "/api/photo" || u.pathname === "/photo") { const r = await core.photo(P.get("name"), P.get("w")); if (!r) { res.writeHead(404); return res.end(); } res.setHeader("Content-Type", r.contentType); res.setHeader("Cache-Control", "public, max-age=86400"); res.writeHead(200); return res.end(r.buffer); }
    if (u.pathname === "/api/staticmap" || u.pathname === "/staticmap") { const r = await core.staticmap(P.get("size"), P.get("center"), P.get("markers")); if (!r) { res.writeHead(404); return res.end(); } res.setHeader("Content-Type", r.contentType); res.setHeader("Cache-Control", "public, max-age=600"); res.writeHead(200); return res.end(r.buffer); }
    if (u.pathname === "/api/health") return json(200, { ok: true, googleKey: Boolean(core.G_KEY), naverOn: core.NAVER_ON });
  } catch (e) { return json(500, { error: e.message }); }

  // 정적
  const file = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  const full = path.join(HERE, file);
  if (!full.startsWith(HERE)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(full).toLowerCase();
    const mime = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" }[ext] || "application/octet-stream";
    res.setHeader("Content-Type", mime + "; charset=utf-8");
    res.end(buf);
  });
});
server.listen(PORT, () => {
  console.log(`내 주변 맛집 앱: http://localhost:${PORT}`);
  console.log(`  Google: ${core.G_KEY ? "OK" : "없음"} · Naver 실시간교통: ${core.NAVER_ON ? "ON" : "OFF"}`);
});
