// Vercel 서버리스 함수: /api/auth  (회원가입/로그인)
// 아이디(영문) + 비밀번호(숫자 4자리). 비번은 salt+sha256 해시로 저장.
// 로그인/가입 성공 시 토큰을 발급하고 sessions 테이블에 저장한다.

const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다.');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        salt     TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token    TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    })().catch((err) => { initPromise = null; throw err; });
  }
  return initPromise;
}

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9]{2,19}$/; // 영문 시작, 영문/숫자 3~20자
const PIN_RE = /^\d{4}$/;                            // 숫자 4자리

const genSalt = () => crypto.randomBytes(8).toString('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
const hashPin = (pin, salt) => crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { throw new Error('잘못된 JSON 형식입니다.'); } }
  return req.body;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

    const body = parseBody(req);
    const action = body.action;
    const username = String(body.username || '').trim();
    const pin = String(body.pin || '').trim();

    if (!USERNAME_RE.test(username)) return res.status(400).json({ success: false, message: '아이디는 영문으로 시작하는 영문/숫자 3~20자여야 합니다.' });
    if (!PIN_RE.test(pin)) return res.status(400).json({ success: false, message: '비밀번호는 숫자 4자리여야 합니다.' });

    if (action === 'signup') {
      const exists = await pool.query('SELECT 1 FROM users WHERE username=$1', [username]);
      if (exists.rows.length) return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다.' });
      const salt = genSalt();
      await pool.query('INSERT INTO users (username, salt, pin_hash) VALUES ($1,$2,$3)', [username, salt, hashPin(pin, salt)]);
      const token = genToken();
      await pool.query('INSERT INTO sessions (token, username) VALUES ($1,$2)', [token, username]);
      return res.status(201).json({ success: true, username, token });
    }

    if (action === 'login') {
      const { rows } = await pool.query('SELECT salt, pin_hash FROM users WHERE username=$1', [username]);
      if (!rows.length || rows[0].pin_hash !== hashPin(pin, rows[0].salt)) {
        return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
      }
      const token = genToken();
      await pool.query('INSERT INTO sessions (token, username) VALUES ($1,$2)', [token, username]);
      return res.status(200).json({ success: true, username, token });
    }

    return res.status(400).json({ success: false, message: 'action 은 signup 또는 login 이어야 합니다.' });
  } catch (err) {
    console.error('auth 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
