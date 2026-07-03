// study-app 백엔드 서버 (Node.js 내장 모듈만 사용, 외부 패키지 불필요)
// 사용자별(회원가입/로그인) 데이터 격리. 로컬 개발용 — 데이터는 JSON 파일에 저장.
// 배포(Vercel)에서는 api/*.js 서버리스 + Supabase 가 같은 API 계약으로 동작한다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');           // { username: {salt, pinHash} }
const PLANS_FILE = path.join(__dirname, 'study-plans.json');     // { username: { date: rows } }
const TEXTBOOKS_FILE = path.join(__dirname, 'textbooks.json');   // { username: { subj: [...] } }
const EVENTS_FILE = path.join(__dirname, 'events.json');         // { username: [{name, date}] }

const VALID_STATUS = ['미정', '완료', '부분', '미완료'];
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9]{2,19}$/;
const PIN_RE = /^\d{4}$/;

let users = {};
let plans = {};       // 사용자별
let textbooks = {};   // 사용자별
let events = {};      // 사용자별 [{name, date}]
const sessions = {};  // token -> username (메모리, 재시작 시 초기화)

// ── 파일 입출력 ──
function loadJson(file, fallback) {
  try { if (fs.existsSync(file)) { const raw = fs.readFileSync(file, 'utf8'); return raw.trim() ? JSON.parse(raw) : fallback; } }
  catch (err) { console.error(`${path.basename(file)} 로드 실패:`, err.message); }
  return fallback;
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); return true; }
  catch (err) { console.error(`${path.basename(file)} 저장 실패:`, err.message); return false; }
}

// ── 인증 유틸 ──
const genSalt = () => crypto.randomBytes(8).toString('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
const hashPin = (pin, salt) => crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
function resolveUser(req) {
  const token = req.headers['x-auth-token'] || '';
  return token && sessions[token] ? sessions[token] : null;
}

// ── 정규화 ──
function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function normalizeSlot(value) {
  const v = value && typeof value === 'object' ? value : {};
  let status = typeof v.status === 'string' ? v.status : '';
  if (!VALID_STATUS.includes(status)) status = '미정';
  return {
    time: typeof v.time === 'string' ? v.time : '',
    subject: typeof v.subject === 'string' ? v.subject : '',
    textbook: typeof v.textbook === 'string' ? v.textbook : '',
    goal: typeof v.goal === 'string' ? v.goal : '',
    status,
    lacking: typeof v.lacking === 'string' ? v.lacking : '',
  };
}
function normalizeDay(body) {
  let arr;
  if (Array.isArray(body)) arr = body;
  else if (body && typeof body === 'object') arr = Object.values(body);
  else arr = [];
  return arr.slice(0, 50).map(normalizeSlot);
}
function normalizeTextbooks(body) {
  const out = {};
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [subj, arr] of Object.entries(body)) {
      if (typeof subj !== 'string' || !subj.trim() || !Array.isArray(arr)) continue;
      out[subj.trim()] = [...new Set(arr.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim()))];
    }
  }
  return out;
}
function normalizeEvents(body) {
  if (!Array.isArray(body)) return [];
  return body
    .filter((e) => e && typeof e === 'object' && typeof e.name === 'string' && e.name.trim() && isValidDate(e.date))
    .map((e) => ({ name: e.name.trim().slice(0, 40), date: e.date }))
    .slice(0, 30);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('잘못된 JSON 형식입니다.')); } });
    req.on('error', reject);
  });
}
function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// ── 시작 시 로드 ──
users = loadJson(USERS_FILE, {});
plans = loadJson(PLANS_FILE, {});
textbooks = loadJson(TEXTBOOKS_FILE, {});
events = loadJson(EVENTS_FILE, {});

const server = http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

    // ── 인증: 회원가입/로그인 ──
    if (req.method === 'POST' && pathname === '/api/auth') {
      readJsonBody(req).then((body) => {
        const action = body.action;
        const username = String(body.username || '').trim();
        const pin = String(body.pin || '').trim();
        if (!USERNAME_RE.test(username)) return sendJson(res, 400, { success: false, message: '아이디는 영문으로 시작하는 영문/숫자 3~20자여야 합니다.' });
        if (!PIN_RE.test(pin)) return sendJson(res, 400, { success: false, message: '비밀번호는 숫자 4자리여야 합니다.' });

        if (action === 'signup') {
          if (users[username]) return sendJson(res, 409, { success: false, message: '이미 사용 중인 아이디입니다.' });
          const salt = genSalt();
          users[username] = { salt, pinHash: hashPin(pin, salt) };
          saveJson(USERS_FILE, users);
          const token = genToken(); sessions[token] = username;
          return sendJson(res, 201, { success: true, username, token });
        }
        if (action === 'login') {
          const u = users[username];
          if (!u || u.pinHash !== hashPin(pin, u.salt)) return sendJson(res, 401, { success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
          const token = genToken(); sessions[token] = username;
          return sendJson(res, 200, { success: true, username, token });
        }
        return sendJson(res, 400, { success: false, message: 'action 은 signup 또는 login 이어야 합니다.' });
      }).catch((err) => sendJson(res, 400, { success: false, message: err.message }));
      return;
    }

    // ── 이하 API 는 인증 필요 ──
    const isApi = pathname.startsWith('/api/');
    const user = resolveUser(req);
    if (isApi && !user) { sendJson(res, 401, { success: false, message: '로그인이 필요합니다.' }); return; }

    // 계획 전체 조회
    if (req.method === 'GET' && pathname === '/api/plans') { sendJson(res, 200, plans[user] || {}); return; }
    // 교재 조회
    if (req.method === 'GET' && pathname === '/api/textbooks') { sendJson(res, 200, textbooks[user] || {}); return; }
    // 시험 일정 조회
    if (req.method === 'GET' && pathname === '/api/events') { sendJson(res, 200, events[user] || []); return; }

    // 계획 저장 (PUT /api/plans/:date)
    if (req.method === 'PUT' && pathname.startsWith('/api/plans/')) {
      const date = pathname.slice('/api/plans/'.length);
      if (!isValidDate(date)) { sendJson(res, 400, { success: false, message: '날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)' }); return; }
      readJsonBody(req).then((body) => {
        if (!body || typeof body !== 'object') return sendJson(res, 400, { success: false, message: '요청 본문은 계획 행 배열이어야 합니다.' });
        if (!plans[user]) plans[user] = {};
        plans[user][date] = normalizeDay(body);
        saveJson(PLANS_FILE, plans);
        sendJson(res, 200, { success: true, date, plan: plans[user][date] });
      }).catch((err) => sendJson(res, 400, { success: false, message: err.message }));
      return;
    }
    // 계획 삭제
    if (req.method === 'DELETE' && pathname.startsWith('/api/plans/')) {
      const date = pathname.slice('/api/plans/'.length);
      if (!isValidDate(date)) { sendJson(res, 400, { success: false, message: '날짜 형식이 올바르지 않습니다.' }); return; }
      if (plans[user]) { delete plans[user][date]; saveJson(PLANS_FILE, plans); }
      sendJson(res, 200, { success: true, date });
      return;
    }
    // 교재 저장
    if (req.method === 'PUT' && pathname === '/api/textbooks') {
      readJsonBody(req).then((body) => {
        textbooks[user] = normalizeTextbooks(body);
        saveJson(TEXTBOOKS_FILE, textbooks);
        sendJson(res, 200, { success: true, textbooks: textbooks[user] });
      }).catch((err) => sendJson(res, 400, { success: false, message: err.message }));
      return;
    }
    // 시험 일정 저장
    if (req.method === 'PUT' && pathname === '/api/events') {
      readJsonBody(req).then((body) => {
        events[user] = normalizeEvents(body);
        saveJson(EVENTS_FILE, events);
        sendJson(res, 200, { success: true, events: events[user] });
      }).catch((err) => sendJson(res, 400, { success: false, message: err.message }));
      return;
    }

    // ── 정적 파일 ──
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('index.html 없음'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data);
      });
      return;
    }
    if (req.method === 'GET') {
      const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, safePath);
      if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('접근 금지'); }
      const base = path.basename(filePath);
      if (['users.json', 'study-plans.json', 'textbooks.json', 'events.json'].includes(base)) { sendJson(res, 404, { success: false, message: 'Not Found' }); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { sendJson(res, 404, { success: false, message: 'Not Found' }); return; }
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime }); res.end(data);
      });
      return;
    }

    sendJson(res, 404, { success: false, message: 'Not Found' });
  } catch (err) {
    console.error('서버 오류:', err);
    try { sendJson(res, 500, { success: false, message: '서버 내부 오류가 발생했습니다.' }); } catch (_) {}
  }
});

server.listen(PORT, () => console.log(`study-app 서버 실행 중: http://localhost:${PORT}`));
module.exports = server;
