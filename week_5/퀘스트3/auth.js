// 공용 인증 모듈 (로컬 server.js + Vercel api/*.js 에서 함께 사용)
// 외부 의존성 없이 Node 내장 crypto 만 사용한다.
//  - 비밀번호: scrypt 해시 (salt.hash hex)
//  - 토큰: JWT (HS256) 직접 서명/검증
const crypto = require('crypto');

const TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // 7일

function getSecret() {
  return (process.env.JWT_SECRET || 'dev-insecure-secret-please-set-JWT_SECRET').trim();
}

// ---------- base64url ----------
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// ---------- 비밀번호 해시 ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + '.' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split('.');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------- JWT (HS256) ----------
function signToken(payload, ttlSec = TOKEN_TTL_SEC) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const p1 = b64urlEncode(JSON.stringify(header));
  const p2 = b64urlEncode(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', getSecret()).update(p1 + '.' + p2).digest();
  return p1 + '.' + p2 + '.' + b64urlEncode(sig);
}
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [p1, p2, sig] = parts;
  const expected = b64urlEncode(crypto.createHmac('sha256', getSecret()).update(p1 + '.' + p2).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try {
    body = JSON.parse(b64urlDecode(p2).toString('utf8'));
  } catch {
    return null;
  }
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
  return body;
}

// Authorization: Bearer <token> 헤더에서 사용자 정보 추출 (없거나 무효면 null)
function getUserFromReq(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const payload = verifyToken(m[1]);
  if (!payload || !payload.uid) return null;
  return { id: payload.uid, username: payload.username };
}

// ---------- DB 스키마 (community_users 테이블) ----------
// ⚠️ 이 Supabase 는 여러 앱이 공유한다. 기존 users/todo_users 와 충돌하지 않도록
//    이 앱 전용으로 'community_users' 테이블만 사용한다. (다른 테이블은 건드리지 않는다.)
async function ensureAuthSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// 입력 검증
function validateCredentials(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (u.length < 3 || u.length > 30) return '아이디는 3~30자로 입력해 주세요.';
  if (!/^[A-Za-z0-9가-힣_.-]+$/.test(u)) return '아이디는 한글/영문/숫자와 _ . - 만 사용할 수 있어요.';
  if (p.length < 4 || p.length > 72) return '비밀번호는 4자 이상으로 입력해 주세요.';
  return null;
}

// HTTP 상태코드를 함께 던지는 에러
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- 회원가입 / 로그인 (server.js, api/auth.js 공용) ----------
async function signup(pool, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const invalid = validateCredentials(username, password);
  if (invalid) throw httpError(400, invalid);

  await ensureAuthSchema(pool);

  const exists = await pool.query('SELECT 1 FROM community_users WHERE username = $1', [username]);
  if (exists.rows.length > 0) throw httpError(409, '이미 사용 중인 아이디입니다.');

  let userId;
  try {
    const { rows } = await pool.query(
      'INSERT INTO community_users (username, password_hash) VALUES ($1,$2) RETURNING id',
      [username, hashPassword(password)]
    );
    userId = rows[0].id;
  } catch (err) {
    if (err.code === '23505') throw httpError(409, '이미 사용 중인 아이디입니다.');
    throw err;
  }

  const token = signToken({ uid: userId, username });
  return { success: true, token, username };
}

async function login(pool, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) throw httpError(400, '아이디와 비밀번호를 입력해 주세요.');

  await ensureAuthSchema(pool);

  const { rows } = await pool.query('SELECT * FROM community_users WHERE username = $1', [username]);
  if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
    throw httpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  const token = signToken({ uid: rows[0].id, username: rows[0].username });
  return { success: true, token, username: rows[0].username };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  getUserFromReq,
  ensureAuthSchema,
  signup,
  login,
  httpError,
};
