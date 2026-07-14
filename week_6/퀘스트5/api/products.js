// Vercel 서버리스 함수: /api/products (상품 목록)
//  - GET  전체 상품 목록 (id ASC).  ⚠️ 인증 불필요 (비로그인 조회 가능)
// 로컬은 server.js 로, 배포는 이 함수로 동작하며 동일한 SQL/시드를 공유한다.
const { Pool } = require('pg');

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

// 테이블 생성 + 시드. 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
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

module.exports = async (req, res) => {
  try {
    await ensureDb();

    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { rows } = await pool.query(
      'SELECT id, name, price, image, description FROM shop_products ORDER BY id ASC'
    );
    return res.status(200).json(rows.map(rowToProduct));
  } catch (err) {
    console.error('상품 목록 처리 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
