// Vercel 서버리스 함수: /api/profile
//  - GET  현재 사용자 프로필(사진 포함) 조회
//  - PUT  프로필 사진 URL 저장 (빈 문자열이면 사진 제거)
// ⚠️ 전부 인증 필수 (Authorization: Bearer <token>), 본인 것만.
const { Pool } = require('pg');
const auth = require('../auth');
const profile = require('../profile');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await auth.ensureAuthSchema(pool);      // shop_users
      await profile.ensureProfileSchema(pool); // profile_image 컬럼
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

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
    await ensureDb();

    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    if (req.method === 'GET') {
      return res.status(200).json(await profile.getProfile(pool, user.id));
    }

    if (req.method === 'PUT') {
      let body;
      try {
        body = parseBody(req);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      return res.status(200).json(await profile.setProfileImage(pool, user.id, body));
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('프로필 처리 오류:', err);
    return res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
