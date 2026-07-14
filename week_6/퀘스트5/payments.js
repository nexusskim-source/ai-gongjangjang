// 공용 결제 모듈 (로컬 server.js + Vercel api/*.js 에서 함께 사용)
// 토스페이먼츠 결제위젯 승인 흐름의 서버 로직을 담는다.
//  - createOrder(pool, userId)         : 장바구니 기준으로 서버가 금액을 재계산해 주문(shop_orders) 생성
//  - confirmPayment(pool, userId, body): 토스 승인 API 호출 + 금액 위변조 검증 + 장바구니 비우기
// ⚠️ 시크릿키(TOSS_SECRET_KEY)는 서버에서만 process.env 로 읽는다. 프런트/깃에 절대 노출 금지.
// ⚠️ 이 Supabase 는 여러 앱이 공유한다. 이 앱 전용 테이블(shop_orders)만 사용한다.
const crypto = require('crypto');
const auth = require('./auth');

const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

function getSecretKey() {
  return (process.env.TOSS_SECRET_KEY || '').trim();
}

// customerKey: 토스가 허용하는 문자(영문/숫자/-_=.@)만 사용해야 한다.
// 한글 아이디도 있을 수 있으므로 사용자 id 기반의 안전한 값으로 생성한다.
function customerKeyFor(userId) {
  return 'bakery-user-' + String(userId);
}

// ---------- DB 스키마 (shop_orders 테이블) ----------
async function ensureOrderSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      id          SERIAL PRIMARY KEY,
      order_id    TEXT UNIQUE NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES shop_users(id),
      amount      BIGINT NOT NULL,
      order_name  TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'PENDING',
      payment_key TEXT,
      method      TEXT,
      items       JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at     TIMESTAMPTZ
    )
  `);
}

// 서버에서 직접 장바구니를 읽어 합계를 계산한다. (프런트가 보낸 금액을 절대 신뢰하지 않음)
async function getUserCart(pool, userId) {
  const { rows } = await pool.query(
    `SELECT c.product_id, c.quantity, p.name, p.price
       FROM shop_cart_items c
       JOIN shop_products p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.created_at ASC`,
    [userId]
  );
  const items = rows.map((r) => {
    const price = Number(r.price);
    const quantity = Number(r.quantity);
    return { productId: r.product_id, name: r.name || '', price, quantity, subtotal: price * quantity };
  });
  const total = items.reduce((sum, it) => sum + it.subtotal, 0);
  return { items, total };
}

// ---------- 주문 생성 ----------
// 결제 요청 직전에 호출. 서버가 장바구니 합계를 계산해 PENDING 주문을 만들고
// 프런트에는 orderId/amount/orderName/customerKey 만 돌려준다.
async function createOrder(pool, userId) {
  await ensureOrderSchema(pool);
  const { items, total } = await getUserCart(pool, userId);
  if (items.length === 0) throw auth.httpError(400, '장바구니가 비어 있습니다.');
  if (total <= 0) throw auth.httpError(400, '결제 금액이 올바르지 않습니다.');

  // 토스 orderId: 6~64자, 영문/숫자/-_ 허용. 예측 불가능하도록 UUID 사용.
  const orderId = 'order-' + crypto.randomUUID();
  const orderName =
    items.length === 1 ? items[0].name : `${items[0].name} 외 ${items.length - 1}건`;

  await pool.query(
    `INSERT INTO shop_orders (order_id, user_id, amount, order_name, status, items)
     VALUES ($1, $2, $3, $4, 'PENDING', $5::jsonb)`,
    [orderId, userId, total, orderName, JSON.stringify(items)]
  );

  return { orderId, amount: total, orderName, customerKey: customerKeyFor(userId) };
}

// ---------- 결제 승인 ----------
// successUrl 리다이렉트로 받은 paymentKey/orderId/amount 를 검증하고 토스 승인 API 호출.
//  1) 주문(shop_orders) 조회 (order_id + user_id) → 위변조/타인 주문 방지
//  2) 저장된 서버 금액과 리다이렉트 amount 비교 → 금액 위변조 방지
//  3) 시크릿키로 토스 승인 API 호출
//  4) 성공 시 주문 PAID 처리 + 장바구니 비우기 (멱등 처리: 이미 PAID 면 그대로 성공 반환)
async function confirmPayment(pool, userId, body) {
  await ensureOrderSchema(pool);

  const paymentKey = String(body.paymentKey || '').trim();
  const orderId = String(body.orderId || '').trim();
  const amount = Number(body.amount);
  if (!paymentKey || !orderId || !Number.isFinite(amount)) {
    throw auth.httpError(400, '결제 정보가 올바르지 않습니다. (paymentKey/orderId/amount)');
  }

  const secret = getSecretKey();
  if (!secret) {
    throw auth.httpError(500, '서버에 TOSS_SECRET_KEY 가 설정되지 않았습니다.');
  }

  const { rows } = await pool.query(
    'SELECT * FROM shop_orders WHERE order_id = $1 AND user_id = $2',
    [orderId, userId]
  );
  if (rows.length === 0) throw auth.httpError(404, '주문 정보를 찾을 수 없습니다.');
  const order = rows[0];
  const storedAmount = Number(order.amount);

  // 멱등: 이미 승인된 주문이면 재승인하지 않고 그대로 성공 반환 (새로고침 등 중복 방지)
  if (order.status === 'PAID') {
    return {
      success: true,
      alreadyProcessed: true,
      orderId,
      amount: storedAmount,
      orderName: order.order_name,
      method: order.method || null,
    };
  }

  // 금액 위변조 검증: 리다이렉트로 넘어온 amount 가 서버 저장 금액과 다르면 거부
  if (storedAmount !== amount) {
    await pool.query(`UPDATE shop_orders SET status='FAILED' WHERE id=$1`, [order.id]);
    throw auth.httpError(400, '결제 금액이 주문 금액과 일치하지 않습니다.');
  }

  // 토스 승인 API 호출 (Basic 인증: "시크릿키:" 를 base64)
  const encoded = Buffer.from(secret + ':').toString('base64');
  let resp;
  let data;
  try {
    resp = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${encoded}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: storedAmount }),
    });
    data = await resp.json();
  } catch (err) {
    throw auth.httpError(502, '토스 승인 서버 통신에 실패했습니다: ' + err.message);
  }

  if (!resp.ok) {
    // 승인 실패: 주문 FAILED 로 표시하고 토스 에러코드/메시지를 그대로 전달
    await pool.query(`UPDATE shop_orders SET status='FAILED' WHERE id=$1`, [order.id]);
    const e = auth.httpError(resp.status || 400, data.message || '결제 승인에 실패했습니다.');
    e.code = data.code;
    throw e;
  }

  // 승인 성공: 주문 PAID 처리 + 해당 사용자 장바구니 비우기
  await pool.query(
    `UPDATE shop_orders SET status='PAID', payment_key=$1, method=$2, paid_at=now() WHERE id=$3`,
    [paymentKey, data.method || null, order.id]
  );
  await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1', [userId]);

  return {
    success: true,
    orderId,
    amount: storedAmount,
    orderName: order.order_name,
    method: data.method || null,
    approvedAt: data.approvedAt || null,
    receiptUrl: (data.receipt && data.receipt.url) || null,
  };
}

// ---------- 구매내역 조회 ----------
// 결제 완료(PAID)된 주문만 최신순으로 돌려준다. (마이페이지 구매내역용)
async function listOrders(pool, userId) {
  await ensureOrderSchema(pool);
  const { rows } = await pool.query(
    `SELECT order_id, amount, order_name, status, method, items, created_at, paid_at
       FROM shop_orders
      WHERE user_id = $1 AND status = 'PAID'
      ORDER BY paid_at DESC NULLS LAST, created_at DESC`,
    [userId]
  );
  const orders = rows.map((r) => ({
    orderId: r.order_id,
    amount: Number(r.amount),
    orderName: r.order_name || '',
    status: r.status,
    method: r.method || null,
    items: Array.isArray(r.items) ? r.items : [],
    paidAt: r.paid_at,
    createdAt: r.created_at,
  }));
  return { success: true, orders };
}

module.exports = {
  ensureOrderSchema,
  createOrder,
  confirmPayment,
  listOrders,
  customerKeyFor,
};
