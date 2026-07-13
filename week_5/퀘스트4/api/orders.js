// Vercel 서버리스 함수: POST /api/orders (주문 생성)
//  - 결제 요청 직전에 호출. 서버가 장바구니 기준으로 금액을 재계산해 PENDING 주문을 만든다.
//  - 인증 필수 (Authorization: Bearer <token>). 프런트가 보낸 금액은 신뢰하지 않는다.
// 로컬은 server.js 로, 배포는 이 함수로 동작하며 payments.js 공용 로직을 공유한다.
const { Pool } = require('pg');
const auth = require('../auth');
const payments = require('../payments');

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
    initPromise = payments.ensureOrderSchema(pool).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();

    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    // GET: 구매내역 목록 / POST: 주문 생성
    if (req.method === 'GET') {
      try {
        return res.status(200).json(await payments.listOrders(pool, user.id));
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('구매내역 조회 오류:', err);
        return res.status(status).json({ success: false, message: err.message || '서버 오류' });
      }
    }

    if (req.method === 'POST') {
      try {
        const order = await payments.createOrder(pool, user.id);
        return res.status(201).json(order);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('주문 생성 오류:', err);
        return res.status(status).json({ success: false, message: err.message || '서버 오류' });
      }
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('주문 생성 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
