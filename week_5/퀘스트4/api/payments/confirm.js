// Vercel 서버리스 함수: POST /api/payments/confirm (결제 승인)
//  - successUrl 리다이렉트 후 프런트가 paymentKey/orderId/amount 를 담아 호출.
//  - 시크릿키(TOSS_SECRET_KEY)로 토스 승인 API 호출 + 금액 위변조 검증 + 성공 시 장바구니 비우기.
//  - 인증 필수 (Authorization: Bearer <token>).
// 로컬은 server.js 로, 배포는 이 함수로 동작하며 payments.js 공용 로직을 공유한다.
const { Pool } = require('pg');
const auth = require('../../auth');
const payments = require('../../payments');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = payments.ensureOrderSchema(pool).catch((err) => {
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

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    let body;
    try {
      body = parseBody(req);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    try {
      const result = await payments.confirmPayment(pool, user.id, body);
      return res.status(200).json(result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('결제 승인 오류:', err);
      return res.status(status).json({ success: false, message: err.message || '서버 오류', code: err.code });
    }
  } catch (err) {
    console.error('결제 승인 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
