/**
 * Vercel 서버리스 진입점 — 모든 /api/* 요청을 core.js 로 처리.
 * (정적 파일 index.html/places.json 은 Vercel 이 자동 서빙)
 * 환경변수 필요: GOOGLE_MAPS_KEY, (선택) NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 */
const core = require("../core.js");

module.exports = async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const P = u.searchParams;
  const json = (code, obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.status(code).send(JSON.stringify(obj)); };
  const num = (v) => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
  const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.headers["x-real-ip"] || "");

  try {
    if (u.pathname === "/api/home") { const lat = num(P.get("lat")), lng = num(P.get("lng")); if (lat == null || lng == null) return json(400, { error: "위치가 필요해요." }); return json(200, await core.handleHome(lat, lng)); }
    if (u.pathname === "/api/nearby") { const lat = num(P.get("lat")), lng = num(P.get("lng")); if (lat == null || lng == null) return json(400, { error: "위치가 필요해요." }); return json(200, await core.handleNearby(lat, lng, (P.get("q") || "").trim(), P.get("open") === "1", P.get("parking") === "1")); }
    if (u.pathname === "/api/search") { const region = (P.get("region") || "").trim(); if (!region) return json(400, { error: "지역을 입력하세요." }); return json(200, await core.handleRegion(region, (P.get("q") || "").trim(), P.get("open") === "1", P.get("parking") === "1")); }
    if (u.pathname === "/api/iploc") { try { return json(200, await core.iploc(clientIp)); } catch (e) { return json(502, { error: e.message }); } }
    if (u.pathname === "/api/photo") { const r = await core.photo(P.get("name"), P.get("w")); if (!r) return res.status(404).end(); res.setHeader("Content-Type", r.contentType); res.setHeader("Cache-Control", "public, max-age=86400"); return res.status(200).send(r.buffer); }
    if (u.pathname === "/api/staticmap") { const r = await core.staticmap(P.get("size"), P.get("center"), P.get("markers")); if (!r) return res.status(404).end(); res.setHeader("Content-Type", r.contentType); res.setHeader("Cache-Control", "public, max-age=600"); return res.status(200).send(r.buffer); }
    if (u.pathname === "/api/health") return json(200, { ok: true, googleKey: Boolean(core.G_KEY), naverOn: core.NAVER_ON });
    return json(404, { error: "not found" });
  } catch (e) { return json(500, { error: e.message }); }
};
