// Vercel 서버리스 함수: GET /api/admin/dashboard
//  - 사장님(admin) 전용. 카페 운영 DB(cafe_*)를 집계해 대시보드 위젯 데이터를 돌려준다.
const { Pool } = require('pg');
const auth = require('../../auth');
const admin = require('../../admin');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }
    const user = auth.getUserFromReq(req);
    await admin.requireAdmin(pool, user);
    return res.status(200).json(await admin.getDashboard(pool));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('대시보드 조회 오류:', err);
    return res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
