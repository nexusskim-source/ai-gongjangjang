// 디저트/베이커리 쇼핑몰 앱 - 로컬 백엔드 서버 (Node 내장 http)
// 상품목록(비로그인 조회) + 회원가입/로그인 + 장바구니. 데이터는 PostgreSQL(Supabase)에 저장.
// ⚠️ 이 Supabase 는 여러 앱이 공유한다. 이 앱은 전용 테이블
//    (shop_users, shop_products, shop_cart_items) 만 사용한다.
// 배포(Vercel)는 api/*.js 서버리스 함수로 동작하며, 여기와 동일한 SQL/로직을 공유한다.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const auth = require('./auth');
const payments = require('./payments');
const profile = require('./profile');

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'index.html');

if (!process.env.DATABASE_URL) {
  console.error('환경변수 DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
// 환경변수 끝에 붙는 개행 방지를 위해 .trim() 적용.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// ---------- 시드 상품 (shop_products 비어있을 때만 삽입) ----------
// image 는 이모지 문자.  [name, price(원 단위 정수), image, description]
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

// ---------- DB 행(snake_case) -> 클라이언트 JSON(camelCase) ----------
// price 는 BIGINT 라 pg 가 문자열로 돌려주므로 Number() 로 변환한다.
function rowToProduct(r) {
  return {
    id: r.id,
    name: r.name || '',
    price: Number(r.price),
    image: r.image || '',
    description: r.description || '',
  };
}

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

// ---------- 테이블 생성 + 시드 ----------
async function initDb() {
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
  await payments.ensureOrderSchema(pool); // shop_orders (결제/주문 내역)
  await profile.ensureProfileSchema(pool); // shop_users.profile_image
  await seedProducts();
}

// shop_products 가 비어있을 때만 시드 상품 일괄 삽입
async function seedProducts() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM shop_products');
  if (rows[0].c > 0) return;
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

// ---------- 장바구니 조회/변경 (server.js, api/cart.js 공용 로직) ----------
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

// POST: 담기 (이미 있으면 수량 누적)
async function addToCart(userId, body) {
  const productId = Number(body.productId);
  if (!productId || !Number.isInteger(productId)) {
    throw auth.httpError(400, 'productId 가 올바르지 않습니다.');
  }
  let quantity = body.quantity == null ? 1 : Number(body.quantity);
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

// PUT: 수량을 정확히 그 값으로 설정. quantity<=0 이면 항목 삭제.
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

// DELETE: 항목 제거
async function removeFromCart(userId, body) {
  const productId = Number(body.productId);
  if (!productId || !Number.isInteger(productId)) {
    throw auth.httpError(400, 'productId 가 올바르지 않습니다.');
  }
  await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1 AND product_id = $2', [userId, productId]);
  return getCart(userId);
}

// ---------- 응답/요청 헬퍼 ----------
function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(INDEX_FILE, (err, content) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>디저트 쇼핑몰 API 서버</h1><p>index.html 이 아직 준비되지 않았습니다.</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------- 인증 ----------
function requireUser(req, res) {
  const user = auth.getUserFromReq(req);
  if (!user) {
    sendJSON(res, 401, { success: false, message: '로그인이 필요합니다.' });
    return null;
  }
  return user;
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // ---- 인증 (로그인 불필요) ----
    if (pathname === '/api/auth/signup' || pathname === '/api/auth/login') {
      if (method !== 'POST') {
        return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
      }
      try {
        const isSignup = pathname.endsWith('/signup');
        const result = isSignup ? await auth.signup(pool, body) : await auth.login(pool, body);
        return sendJSON(res, isSignup ? 201 : 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('인증 처리 오류:', err);
        return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
      }
    }

    // ---- 상품 목록 (비로그인 조회 가능) ----
    if (pathname === '/api/products') {
      if (method !== 'GET') {
        return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
      }
      const { rows } = await pool.query(
        'SELECT id, name, price, image, description FROM shop_products ORDER BY id ASC'
      );
      return sendJSON(res, 200, rows.map(rowToProduct));
    }

    // ---- ImageKit 업로드 인증 파라미터 (인증 필수) ----
    // 프런트가 파일을 ImageKit 에 직접 올리기 전에 서버 서명을 받아간다.
    if (pathname === '/api/imagekit-auth') {
      if (method !== 'GET') {
        return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
      }
      const user = requireUser(req, res);
      if (!user) return;
      try {
        return sendJSON(res, 200, profile.getUploadAuthParams());
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('ImageKit 인증 오류:', err);
        return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
      }
    }

    // ---- 프로필 조회/사진 저장 (인증 필수, 본인 것만) ----
    if (pathname === '/api/profile') {
      const user = requireUser(req, res);
      if (!user) return;

      if (method === 'GET') {
        try {
          return sendJSON(res, 200, await profile.getProfile(pool, user.id));
        } catch (err) {
          const status = err.status || 500;
          if (status >= 500) console.error('프로필 조회 오류:', err);
          return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
        }
      }

      if (method === 'PUT') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
        }
        try {
          return sendJSON(res, 200, await profile.setProfileImage(pool, user.id, body));
        } catch (err) {
          const status = err.status || 500;
          if (status >= 500) console.error('프로필 저장 오류:', err);
          return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
        }
      }

      return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
    }

    // ---- 장바구니 (전부 인증 필수, 본인 것만) ----
    if (pathname === '/api/cart') {
      const user = requireUser(req, res);
      if (!user) return;

      if (method === 'GET') {
        const cart = await getCart(user.id);
        return sendJSON(res, 200, cart);
      }

      // POST / PUT / DELETE 는 본문을 읽는다
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
        }
        try {
          if (method === 'POST') {
            const cart = await addToCart(user.id, body);
            return sendJSON(res, 201, cart);
          }
          if (method === 'PUT') {
            const cart = await setCartQuantity(user.id, body);
            return sendJSON(res, 200, cart);
          }
          const cart = await removeFromCart(user.id, body);
          return sendJSON(res, 200, cart);
        } catch (err) {
          const status = err.status || 500;
          if (status >= 500) console.error('장바구니 처리 오류:', err);
          return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
        }
      }

      return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
    }

    // ---- 주문: 목록 조회(GET, 구매내역) / 생성(POST, 결제 직전) ----
    // POST 는 서버가 장바구니 기준으로 금액을 재계산해 PENDING 주문을 만든다.
    if (pathname === '/api/orders') {
      const user = requireUser(req, res);
      if (!user) return;

      if (method === 'GET') {
        try {
          return sendJSON(res, 200, await payments.listOrders(pool, user.id));
        } catch (err) {
          const status = err.status || 500;
          if (status >= 500) console.error('구매내역 조회 오류:', err);
          return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
        }
      }

      if (method === 'POST') {
        try {
          const order = await payments.createOrder(pool, user.id);
          return sendJSON(res, 201, order);
        } catch (err) {
          const status = err.status || 500;
          if (status >= 500) console.error('주문 생성 오류:', err);
          return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
        }
      }

      return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
    }

    // ---- 결제 승인 (successUrl 리다이렉트 후 프런트가 호출, 인증 필수) ----
    // 시크릿키로 토스 승인 API 호출 + 금액 위변조 검증 + 성공 시 장바구니 비우기.
    if (pathname === '/api/payments/confirm') {
      if (method !== 'POST') {
        return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
      }
      const user = requireUser(req, res);
      if (!user) return;
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
      }
      try {
        const result = await payments.confirmPayment(pool, user.id, body);
        return sendJSON(res, 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('결제 승인 오류:', err);
        return sendJSON(res, status, { success: false, message: err.message || '서버 오류', code: err.code });
      }
    }

    // ---- 정적 이미지 (/images/*.jpg 등) ----
    if (method === 'GET' && pathname.startsWith('/images/')) {
      const safe = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
      const filePath = path.join(__dirname, safe);
      const imagesDir = path.join(__dirname, 'images');
      if (!filePath.startsWith(imagesDir)) {
        return sendJSON(res, 403, { success: false, message: '접근 금지' });
      }
      return fs.readFile(filePath, (err, data) => {
        if (err) return sendJSON(res, 404, { success: false, message: '이미지를 찾을 수 없습니다.' });
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    }

    // ---- 정적 파일 (index.html) ----
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveIndex(res);
    }

    sendJSON(res, 404, { success: false, message: '페이지를 찾을 수 없습니다.' });
  } catch (err) {
    console.error('서버 오류:', err);
    sendJSON(res, 500, { success: false, message: '서버 내부 오류가 발생했습니다: ' + err.message });
  }
});

// ---------- 서버 시작 ----------
// Supabase pooler 가 가끔 첫 연결을 28P01 로 거부하므로 몇 번 재시도한다.
async function initDbWithRetry(retries = 4, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await initDb();
      return;
    } catch (err) {
      console.warn(`DB 초기화 시도 ${attempt}/${retries} 실패: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// 로컬 실행 시에만 서버 시작. (require 시에는 server export 만)
if (require.main === module) {
  initDbWithRetry()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`디저트 쇼핑몰 서버 실행 중 (Supabase 저장): http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('DB 초기화 최종 실패:', err.message);
      process.exit(1);
    });
}

module.exports = server;
