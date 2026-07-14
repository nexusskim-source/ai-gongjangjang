// Vercel 서버리스 함수: /api/cart (장바구니)
//  - GET    현재 사용자 장바구니 조회
//  - POST   담기 (이미 있으면 수량 누적)
//  - PUT    수량을 정확히 설정 (quantity<=0 이면 삭제)
//  - DELETE 항목 제거
// ⚠️ 전부 인증 필수 (Authorization: Bearer <token>), 본인 것만 조회/수정.
// 로컬은 server.js 로, 배포는 이 함수로 동작하며 동일한 SQL/로직을 공유한다.
const { Pool } = require('pg');
const auth = require('../auth');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// 시드 상품 (shop_products 비어있을 때만 삽입). image 는 이모지 문자.
const SEED_PRODUCTS = [
  ['딸기 생크림 케이크', 32000, '/images/strawberry-cake.jpg', '촉촉한 시트에 신선한 딸기 가득'],
  ['버터 크루아상', 4500, '/images/croissant.jpg', '겹겹이 살아있는 버터 풍미'],
  ['수제 초코칩 쿠키', 3000, '/images/cookie.jpg', '겉바속촉 갓 구운 쿠키'],
  ['마카롱 6구 세트', 18000, '/images/macaron.jpg', '알록달록 프렌치 마카롱'],
  ['티라미수', 8500, '/images/tiramisu.jpg', '마스카포네 크림 가득'],
  ['글레이즈 도넛', 3500, '/images/donut.jpg', '부드럽고 달콤한 도넛'],
  ['뉴욕 치즈케이크', 7500, '/images/cheesecake.jpg', '진한 크림치즈의 정석'],
  ['컵케이크', 4000, '/images/cupcake.jpg', '버터크림 토핑 컵케이크'],
  ['바게트', 5000, '/images/baguette.jpg', '겉은 바삭 속은 쫄깃'],
  ['마들렌 4개입', 6000, '/images/madeleine.jpg', '조개 모양 버터 마들렌'],
  ['아메리카노', 4000, '/images/americano.jpg', '진한 에스프레소에 물을 더한 기본 커피'],
  ['카페라떼', 4500, '/images/latte.jpg', '부드러운 우유와 에스프레소의 조화'],
  ['카푸치노', 4800, '/images/cappuccino.jpg', '풍성한 우유 거품이 매력'],
  ['바닐라 라떼', 5000, '/images/vanilla-latte.jpg', '달콤한 바닐라 향이 가득'],
  ['카라멜 마키아토', 5500, '/images/caramel-macchiato.jpg', '카라멜의 달콤 쌉싸름한 조화'],
  ['아이스 아메리카노', 4300, '/images/iced-americano.jpg', '얼음 가득 시원한 아메리카노'],
];

// 장바구니 행 목록 -> { items, total }
function buildCart(rows) {
  const items = rows.map((r) => {
    const price = Number(r.price);
    const quantity = Number(r.quantity);
    return {
      id: r.id,
      productId: r.product_id,
      name: r.name || '',
      price,
      image: r.image || '',
      quantity,
      subtotal: price * quantity,
    };
  });
  const total = items.reduce((sum, it) => sum + it.subtotal, 0);
  return { items, total };
}

// 테이블 생성 + 시드. 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await auth.ensureAuthSchema(pool); // shop_users
      await pool.query(`
        CREATE TABLE IF NOT EXISTS shop_products (
          id          SERIAL PRIMARY KEY,
          name        TEXT NOT NULL,
          price       BIGINT NOT NULL,
          image       TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS shop_cart_items (
          id         SERIAL PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES shop_users(id),
          product_id INTEGER NOT NULL REFERENCES shop_products(id),
          quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, product_id)
        )
      `);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM shop_products');
      if (rows[0].c === 0) {
        const valuePlaceholders = [];
        const params = [];
        SEED_PRODUCTS.forEach((p, i) => {
          const b = i * 4;
          valuePlaceholders.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
          params.push(p[0], p[1], p[2], p[3]);
        });
        await pool.query(
          `INSERT INTO shop_products (name, price, image, description) VALUES ${valuePlaceholders.join(',')}`,
          params
        );
      }
    })().catch((err) => {
      initPromise = null; // 실패 시 다음 호출에서 재시도
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

// ---------- 장바구니 조회/변경 ----------
async function getCart(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.product_id, c.quantity, p.name, p.price, p.image
       FROM shop_cart_items c
       JOIN shop_products p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.created_at ASC`,
    [userId]
  );
  return buildCart(rows);
}

async function addToCart(userId, body) {
  const productId = Number(body.productId);
  if (!productId || !Number.isInteger(productId)) {
    throw auth.httpError(400, 'productId 가 올바르지 않습니다.');
  }
  const quantity = body.quantity == null ? 1 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw auth.httpError(400, 'quantity 는 1 이상의 정수여야 합니다.');
  }
  const prod = await pool.query('SELECT 1 FROM shop_products WHERE id = $1', [productId]);
  if (prod.rows.length === 0) throw auth.httpError(404, '상품을 찾을 수 없습니다.');

  await pool.query(
    `INSERT INTO shop_cart_items (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id)
     DO UPDATE SET quantity = shop_cart_items.quantity + EXCLUDED.quantity`,
    [userId, productId, quantity]
  );
  return getCart(userId);
}

async function setCartQuantity(userId, body) {
  const productId = Number(body.productId);
  if (!productId || !Number.isInteger(productId)) {
    throw auth.httpError(400, 'productId 가 올바르지 않습니다.');
  }
  if (body.quantity == null || !Number.isInteger(Number(body.quantity))) {
    throw auth.httpError(400, 'quantity 는 정수여야 합니다.');
  }
  const quantity = Number(body.quantity);
  if (quantity <= 0) {
    await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1 AND product_id = $2', [userId, productId]);
    return getCart(userId);
  }
  const prod = await pool.query('SELECT 1 FROM shop_products WHERE id = $1', [productId]);
  if (prod.rows.length === 0) throw auth.httpError(404, '상품을 찾을 수 없습니다.');

  await pool.query(
    `INSERT INTO shop_cart_items (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id)
     DO UPDATE SET quantity = EXCLUDED.quantity`,
    [userId, productId, quantity]
  );
  return getCart(userId);
}

async function removeFromCart(userId, body) {
  const productId = Number(body.productId);
  if (!productId || !Number.isInteger(productId)) {
    throw auth.httpError(400, 'productId 가 올바르지 않습니다.');
  }
  await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1 AND product_id = $2', [userId, productId]);
  return getCart(userId);
}

module.exports = async (req, res) => {
  try {
    await ensureDb();

    // 🔐 인증 필수
    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    if (req.method === 'GET') {
      return res.status(200).json(await getCart(user.id));
    }

    let body;
    try {
      body = parseBody(req);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    try {
      if (req.method === 'POST') {
        return res.status(201).json(await addToCart(user.id, body));
      }
      if (req.method === 'PUT') {
        return res.status(200).json(await setCartQuantity(user.id, body));
      }
      if (req.method === 'DELETE') {
        return res.status(200).json(await removeFromCart(user.id, body));
      }
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('장바구니 처리 오류:', err);
      return res.status(status).json({ success: false, message: err.message || '서버 오류' });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('장바구니 처리 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
