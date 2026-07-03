// Vercel 서버리스 함수: /api/plans, /api/plans/:date  (사용자별)
// 공부 계획을 PostgreSQL(Supabase) user_plans 에 사용자별로 저장. 하루치를 JSONB 배열로 보관.
// 모든 요청은 X-Auth-Token 헤더로 인증된 사용자에 한정된다.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const VALID_STATUS = ['미정', '완료', '부분', '미완료'];

let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS user_plans (
        username TEXT NOT NULL,
        date     TEXT NOT NULL,
        plan     JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (username, date)
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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { throw new Error('잘못된 JSON 형식입니다.'); } }
  return req.body;
}
function dateFromUrl(req) {
  const pathname = decodeURIComponent((req.url || '').split('?')[0]);
  const m = pathname.match(/^\/api\/plans\/(.+)$/);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });

    const date = dateFromUrl(req);

    if (req.method === 'GET' && !date) {
      const { rows } = await pool.query('SELECT date, plan FROM user_plans WHERE username=$1', [user]);
      const all = {};
      for (const r of rows) all[r.date] = r.plan;
      return res.status(200).json(all);
    }

    if (req.method === 'PUT' && date) {
      if (!isValidDate(date)) return res.status(400).json({ success: false, message: '날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
      const body = parseBody(req);
      if (!body || typeof body !== 'object') return res.status(400).json({ success: false, message: '요청 본문은 계획 행 배열이어야 합니다.' });
      const plan = normalizeDay(body);
      await pool.query(
        `INSERT INTO user_plans (username, date, plan, updated_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (username, date) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()`,
        [user, date, JSON.stringify(plan)]
      );
      return res.status(200).json({ success: true, date, plan });
    }

    if (req.method === 'DELETE' && date) {
      if (!isValidDate(date)) return res.status(400).json({ success: false, message: '날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
      await pool.query('DELETE FROM user_plans WHERE username=$1 AND date=$2', [user, date]);
      return res.status(200).json({ success: true, date });
    }

    res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('요청 처리 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
