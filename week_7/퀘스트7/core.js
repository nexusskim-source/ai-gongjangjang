/**
 * 공유 코어 로직 — 로컬(server.js)과 Vercel(api/[...path].js)이 함께 사용.
 * 구글 Places(New) + 네이버 Directions 호출, 큐레이션(식객/수요미식회) 보강.
 * 키는 환경변수 우선(Vercel), 없으면 로컬 C:\cafe-finder-bot txt 폴백.
 */
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ON_VERCEL = Boolean(process.env.VERCEL);
const KEY_DIR = process.env.KEY_DIR || "C:\\cafe-finder-bot";

const NEARBY_BIAS_M = 3000, NEARBY_KEEP_KM = 5, CURATED_KEEP_KM = 6, ROAD_FACTOR = 1.3, WALK_KMH = 4.5;

function readKey(file, env) {
  if (process.env[env]) return process.env[env].trim();
  try { return fs.readFileSync(path.join(KEY_DIR, file), "utf8").trim() || null; } catch { return null; }
}
const G_KEY = readKey("google_maps_key.txt", "GOOGLE_MAPS_KEY");
const NAVER_ID = readKey("naver_client_id.txt", "NAVER_CLIENT_ID");
const NAVER_SECRET = readKey("naver_client_secret.txt", "NAVER_CLIENT_SECRET");
const NAVER_ON = Boolean(NAVER_ID && NAVER_SECRET);

// require 로 읽어야 Vercel 번들러가 JSON 을 함수에 포함시킨다.
function loadPlaces() {
  try { return require("./places.json").places || []; } catch { return []; }
}

// 캐시
const cache = new Map();
const cget = (k) => { const v = cache.get(k); return v && Date.now() - v.t < 6e5 ? v.d : null; };
const cset = (k, d) => cache.set(k, { t: Date.now(), d });

// 큐레이션 좌표: 배포용 baked 파일 우선 로드(런타임 구글 재조회 최소화)
// require 로 읽어 Vercel 번들에 포함. 없으면 런타임 조회로 채운다.
let geoCache = {};
try { geoCache = Object.assign({}, require("./curated_geo.json")); }
catch { try { geoCache = Object.assign({}, require("./curated_geo.cache.json")); } catch {} }
let geoDirty = false;
if (!ON_VERCEL) {
  setInterval(() => {
    if (geoDirty) { fs.writeFile(path.join(HERE, "curated_geo.cache.json"), JSON.stringify(geoCache), () => {}); geoDirty = false; }
  }, 4000).unref();
}

const G_FIELDS = [
  "places.displayName", "places.rating", "places.userRatingCount", "places.formattedAddress",
  "places.googleMapsUri", "places.location", "places.primaryTypeDisplayName", "places.types",
  "places.priceLevel", "places.currentOpeningHours", "places.photos", "places.parkingOptions",
  "places.allowsDogs",
].join(",");

async function placesSearch(textQuery, pageSize = 20, bias = null) {
  if (!G_KEY) throw new Error("GOOGLE_MAPS_KEY 없음");
  const ck = "g:" + textQuery + ":" + pageSize + ":" + (bias ? `${bias.lat},${bias.lng}` : "");
  const hit = cget(ck); if (hit) return hit;
  const body = { textQuery, languageCode: "ko", regionCode: "KR", pageSize };
  if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: NEARBY_BIAS_M } };
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": G_KEY, "X-Goog-FieldMask": G_FIELDS },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const out = (await res.json()).places || [];
  cset(ck, out);
  return out;
}

const PRICE_MAP = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
const cleanName = (raw) => { if (!raw) return ""; const n = raw.split(/\s*[|/]\s*/)[0].trim(); return n.length > 26 ? n.slice(0, 26).trim() : n; };
const firstPhoto = (p) => (p.photos || [])[0]?.name || null;
function normGoogle(p) {
  const open = p.currentOpeningHours?.openNow;
  const parking = p.parkingOptions ? Boolean(p.parkingOptions.freeParkingLot || p.parkingOptions.freeStreetParking || p.parkingOptions.paidParkingLot || p.parkingOptions.valetParking || p.parkingOptions.freeGarageParking) : null;
  return {
    name: cleanName(p.displayName?.text || ""), address: p.formattedAddress || "",
    rating: p.rating ?? null, reviews: p.userRatingCount ?? 0, mapUri: p.googleMapsUri || "",
    category: p.primaryTypeDisplayName?.text || "", types: p.types || [],
    price: p.priceLevel != null ? (PRICE_MAP[p.priceLevel] ?? null) : null,
    openNow: open === undefined ? null : open, parking, photo: firstPhoto(p),
    petOk: p.allowsDogs === undefined ? null : p.allowsDogs,
    lat: p.location?.latitude ?? null, lng: p.location?.longitude ?? null,
  };
}

function haversineKm(a, b, c, d) {
  const R = 6371, r = Math.PI / 180, dp = (c - a) * r, dl = (d - b) * r;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const walkMinOf = (km) => Math.round((km * ROAD_FACTOR) / WALK_KMH * 60);
async function naverDriveMin(oLat, oLng, dLat, dLng) {
  if (!NAVER_ON || oLat == null || dLat == null) return null;
  const url = "https://maps.apigw.ntruss.com/map-direction/v1/driving?" + new URLSearchParams({ start: `${oLng},${oLat}`, goal: `${dLng},${dLat}`, option: "trafast" });
  try {
    const res = await fetch(url, { headers: { "X-NCP-APIGW-API-KEY-ID": NAVER_ID, "X-NCP-APIGW-API-KEY": NAVER_SECRET } });
    if (!res.ok) return null;
    const data = await res.json();
    const route = data.code === 0 ? data.route?.trafast?.[0] : null;
    return route ? Math.round(route.summary.duration / 1000 / 60) : null;
  } catch { return null; }
}
async function attachTimes(user, list) {
  await Promise.all(list.map(async (it) => {
    if (it.lat == null) return;
    it.distKm = haversineKm(user.lat, user.lng, it.lat, it.lng);
    it.walkMin = walkMinOf(it.distKm);
    it.driveMin = it.walkMin > 25 ? await naverDriveMin(user.lat, user.lng, it.lat, it.lng) : null;
  }));
  return list;
}

const curatedNaver = (c) => "https://map.naver.com/p/search/" + encodeURIComponent(`${c.region} ${c.name}`);
async function enrichCurated(c) {
  const key = c.name + "|" + c.region;
  if (!geoCache[key]) {
    try { const r = await placesSearch(`${c.name} ${c.region}`, 1); geoCache[key] = r[0] ? normGoogle(r[0]) : { none: true }; geoDirty = true; }
    catch { geoCache[key] = { none: true }; }
  }
  const g = geoCache[key] || {};
  return {
    name: c.name, region: c.region, category: c.category, source: c.source, reason: c.reason, episode: c.episode || "",
    rating: g.rating ?? null, reviews: g.reviews ?? 0, address: g.address || c.region, mapUri: g.mapUri || curatedNaver(c),
    price: g.price ?? null, openNow: g.openNow ?? null, parking: g.parking ?? null, petOk: g.petOk ?? null, photo: g.photo ?? null,
    lat: g.lat ?? null, lng: g.lng ?? null,
  };
}

function applyFlags(list, open, parking) {
  let out = list;
  if (open) out = out.filter((p) => p.openNow === true);
  if (parking) out = out.filter((p) => p.parking === true);
  return out;
}
async function googleNearby(user, q, open, parking) {
  const raw = await placesSearch(q, 20, user);
  let list = raw.map(normGoogle).filter((p) => p.lat != null && p.reviews >= 15)
    .map((p) => ({ ...p, distKm: haversineKm(user.lat, user.lng, p.lat, p.lng) }))
    .filter((p) => p.distKm <= NEARBY_KEEP_KM).sort((a, b) => a.distKm - b.distKm);
  list = applyFlags(list, open, parking).slice(0, 18);
  await attachTimes(user, list);
  return list;
}
async function curatedNearby(user) {
  const all = await Promise.all(loadPlaces().map(enrichCurated));
  const near = all.filter((c) => c.lat != null).map((c) => ({ ...c, distKm: haversineKm(user.lat, user.lng, c.lat, c.lng) })).filter((c) => c.distKm <= CURATED_KEEP_KM);
  const sikgaek = near.filter((c) => c.source === "식객").sort((a, b) => a.distKm - b.distKm);
  const sumi = near.filter((c) => c.source === "수요미식회").sort((a, b) => a.distKm - b.distKm);
  await attachTimes(user, sikgaek); await attachTimes(user, sumi);
  return { sikgaek, sumi };
}
const tokenMatch = (keywords, q) => { if (!q) return true; const qq = q.replace(/\s+/g, ""); return (keywords || []).some((k) => { const kk = k.replace(/\s+/g, ""); return kk.includes(qq) || qq.includes(kk); }); };

// 카페/디저트 의도 검색 여부 — 큐레이션(식객·수요미식회)은 전부 식당이라, 카페 검색엔 섞지 않는다.
const CAFE_HINT = /카페|디저트|커피|베이커리|브런치|빵집|로스터리/;
const isCafeQuery = (q) => CAFE_HINT.test(q || "");

// 업종(카테고리) 키별 대표 키워드 — 큐레이션의 category 문자열을 선택 업종에 맞게 거른다.
const CAT_KW = {
  korean: ["한식", "한정식", "백반", "곰탕", "설렁탕", "순댓국", "순대", "국밥", "해장", "찌개", "전골", "순두부", "김치", "동태", "닭곰탕", "보쌈", "족발", "낙지", "대게", "해물", "해산물", "남도", "가정식", "백숙", "생선구이", "감자국", "한우", "비빔밥", "쌈밥"],
  jp: ["일식", "일본", "라멘", "소바", "우동", "돈카츠", "돈까스", "스시", "초밥", "이자카야", "사시미", "오마카세", "모츠나베", "텐동", "규동"],
  cn: ["중식", "중국", "탕수육", "짜장", "짬뽕", "마라", "양꼬치", "딤섬", "훠궈"],
  western: ["양식", "이탈리", "파스타", "피자", "스테이크", "브런치", "버거", "프렌치", "스페인", "다국적", "레스토랑", "비스트로"],
  meat: ["고기", "구이", "갈비", "삼겹", "곱창", "막창", "양고기", "소갈비", "한우", "바베큐", "정육", "양꼬치", "불고기"],
  cafe: ["카페", "커피", "베이커리", "브런치", "로스터리"],
  dessert: ["디저트", "베이커리", "빵", "케이크", "도넛", "아이스크림", "마카롱", "크레페", "젤라또", "와플"],
  noodle: ["국수", "냉면", "분식", "칼국수", "콩국수", "소바", "라멘", "우동", "떡볶이", "쌀국수", "면", "만두", "메밀", "막국수"],
};
// 선택한 업종에 맞는 큐레이션만 남긴다. 업종 미선택이면 전체 유지, 카페/디저트면 식당 큐레이션 없음.
function filterCuratedByCat(list, cat) {
  if (!cat) return list;
  if (cat === "cafe" || cat === "dessert") return [];
  const kw = CAT_KW[cat];
  if (!kw) return list;
  return list.filter((c) => kw.some((k) => (c.category || "").includes(k)));
}

// ── 공개 핸들러 ──────────────────────────────────────────
async function handleHome(lat, lng) {
  const user = { lat, lng };
  const [popular, cafes, curated] = await Promise.all([
    googleNearby(user, "맛집").catch(() => []),
    googleNearby(user, "카페").catch(() => []),
    curatedNearby(user).catch(() => ({ sikgaek: [], sumi: [] })),
  ]);
  return { naverOn: NAVER_ON, popular: popular.slice(0, 8), cafes: cafes.slice(0, 8), sikgaek: curated.sikgaek, sumi: curated.sumi };
}
async function handleNearby(lat, lng, q, open, parking, cat) {
  const user = { lat, lng };
  let google = [], googleError = null;
  try { google = await googleNearby(user, q || "맛집", open, parking); } catch (e) { googleError = e.message; }
  // 카페/디저트면 식당 큐레이션 제외, 그 외 업종이면 선택 업종에 맞는 큐레이션만 남긴다
  let { sikgaek, sumi } = isCafeQuery(q) ? { sikgaek: [], sumi: [] } : await curatedNearby(user).catch(() => ({ sikgaek: [], sumi: [] }));
  sikgaek = filterCuratedByCat(sikgaek, cat); sumi = filterCuratedByCat(sumi, cat);
  const fS = applyFlags(sikgaek, open, parking), fU = applyFlags(sumi, open, parking);
  return { mode: "nearby", naverOn: NAVER_ON, counts: { sikgaek: fS.length, sumi: fU.length, google: google.length }, sikgaek: fS, sumi: fU, google, googleError };
}
async function handleRegion(region, q, open, parking, cat) {
  const places = loadPlaces();
  const pick = (src) => places.filter((p) => p.source === src && (tokenMatch(p.regionKeywords, region) || tokenMatch([p.region], region)));
  let google = [], googleError = null;
  try {
    const gq = [region, q, "맛집"].filter(Boolean).join(" ");
    google = (await placesSearch(gq, 20)).map(normGoogle).filter((p) => p.reviews >= 20).sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.reviews - a.reviews);
    google = applyFlags(google, open, parking).slice(0, 15);
  } catch (e) { googleError = e.message; }
  // 카페/디저트면 식당 큐레이션 제외, 그 외 업종이면 선택 업종에 맞는 큐레이션만 남긴다
  let [sikgaek, sumi] = isCafeQuery(q)
    ? [[], []]
    : await Promise.all([Promise.all(pick("식객").map(enrichCurated)), Promise.all(pick("수요미식회").map(enrichCurated))]);
  sikgaek = applyFlags(filterCuratedByCat(sikgaek, cat), open, parking).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  sumi = applyFlags(filterCuratedByCat(sumi, cat), open, parking).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return { mode: "region", region, naverOn: NAVER_ON, counts: { sikgaek: sikgaek.length, sumi: sumi.length, google: google.length }, sikgaek, sumi, google, googleError };
}
async function iploc(clientIp) {
  const ipPart = clientIp && !/^(127\.|::1|10\.|192\.168\.)/.test(clientIp) ? clientIp : "";
  const r = await fetch(`http://ip-api.com/json/${ipPart}?fields=status,lat,lon,city,regionName`);
  const j = await r.json();
  if (j.status === "success" && j.lat != null) return { lat: j.lat, lng: j.lon, city: [j.regionName, j.city].filter(Boolean).join(" ") };
  throw new Error("IP 위치 조회 실패");
}
async function photo(name, w) {
  if (!name || !G_KEY) return null;
  const width = Math.min(parseInt(w || "640", 10) || 640, 1200);
  const r = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${width}&key=${G_KEY}`);
  if (!r.ok) return null;
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") || "image/jpeg" };
}
async function staticmap(size, center, markers) {
  if (!G_KEY) return null;
  const params = new URLSearchParams({ size: (size || "640x360").replace(/[^0-9x]/g, ""), scale: "2", language: "ko", key: G_KEY });
  if (center) params.append("center", center);
  (markers || "").split(";").filter(Boolean).slice(0, 20).forEach((m, i) => params.append("markers", `color:0x0f9d6f|label:${i + 1 <= 9 ? i + 1 : ""}|${m}`));
  const r = await fetch("https://maps.googleapis.com/maps/api/staticmap?" + params);
  if (!r.ok) return null;
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") || "image/png" };
}

module.exports = { handleHome, handleNearby, handleRegion, iploc, photo, staticmap, G_KEY, NAVER_ON };
