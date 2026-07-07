// Vercel 서버리스 함수: /api/auth/signup, /api/auth/login
// 로컬은 server.js 로, 배포는 이 함수로 동작한다. (shop_users 테이블 사용)
const { Pool } = require('pg');
const auth = require('../auth');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

// 서버리스 warm 인스턴스에서 풀을 재사용
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('잘못된 JSON 형식입니다.');
    }
  }
  return req.body;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const url = (req.url || '').split('?')[0];
    const action = url.endsWith('/signup') ? 'signup' : url.endsWith('/login') ? 'login' : null;
    if (!action) {
      return res.status(404).json({ success: false, message: '알 수 없는 인증 경로입니다.' });
    }

    const body = parseBody(req);
    const result = action === 'signup' ? await auth.signup(pool, body) : await auth.login(pool, body);
    return res.status(action === 'signup' ? 201 : 200).json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('인증 처리 오류:', err);
    return res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
