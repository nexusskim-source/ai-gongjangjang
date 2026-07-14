// Vercel 서버리스 함수: POST /api/admin/briefing
//  - 사장님(admin) 전용. 카페 데이터 + 오늘 날씨 예보를 종합해 AI 가 "오늘의 카페 브리핑"을 쓴다.
//  - OPENAI_API_KEY 가 없으면 규칙 기반 브리핑으로 대체된다.
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
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }
    const user = auth.getUserFromReq(req);
    await admin.requireAdmin(pool, user);
    return res.status(200).json(await admin.generateBriefing(pool));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('AI 브리핑 오류:', err);
    return res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
