// Vercel 서버리스 함수: /api/events  (사용자별 중요 시험 일정 — D-day)
// user_events 에 사용자별 한 행(JSONB 배열)으로 저장. [{name, date}]
// 모든 요청은 X-Auth-Token 헤더로 인증된 사용자에 한정된다.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS user_events (
        username TEXT PRIMARY KEY,
        value    JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    })().catch((err) => { initPromise = null; throw err; });
  }
  return initPromise;
}

async function resolveUser(req) {
  const token = req.headers['x-auth-token'] || '';
  if (!token) return null;
  const { rows } = await pool.query('SELECT username FROM sessions WHERE token=$1', [token]);
  return rows[0] ? rows[0].username : null;
}

function isValidDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, dd] = d.split('-').map(Number);
  const dt = new Date(y, m - 1, dd);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === dd;
}
// 일정 배열 정규화: [{name, date}] (이름 비거나 날짜 형식 틀리면 제외)
function normalizeEvents(body) {
  if (!Array.isArray(body)) return [];
  return body
    .filter((e) => e && typeof e === 'object' && typeof e.name === 'string' && e.name.trim() && isValidDate(e.date))
    .map((e) => ({ name: e.name.trim().slice(0, 40), date: e.date }))
    .slice(0, 30);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { throw new Error('잘못된 JSON 형식입니다.'); } }
  return req.body;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });

    if (req.method === 'GET') {
      const { rows } = await pool.query('SELECT value FROM user_events WHERE username=$1', [user]);
      return res.status(200).json(rows[0] ? rows[0].value : []);
    }

    if (req.method === 'PUT') {
      const events = normalizeEvents(parseBody(req));
      await pool.query(
        `INSERT INTO user_events (username, value, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (username) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [user, JSON.stringify(events)]
      );
      return res.status(200).json({ success: true, events });
    }

    res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('요청 처리 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
