// 시드 데이터 검증 — node check.js
require('dotenv').config();
const { Client } = require('pg');

const Q = [
  ['① 일별 매출 (최근 7일)', `
    SELECT sale_date AS 날짜, weekday AS 요일, weather AS 날씨,
           visitors AS 손님수, order_count AS 주문수, revenue AS 매출
    FROM cafe_daily_sales ORDER BY sale_date DESC LIMIT 7`],
  ['② 메뉴별 판매량 TOP 8 (90일 누적)', `
    SELECT m.name AS 메뉴, m.category AS 구분,
           SUM(s.qty) AS 판매량, SUM(s.amount) AS 매출액
    FROM cafe_menu_sales s JOIN cafe_menus m ON m.id = s.menu_id
    GROUP BY m.name, m.category ORDER BY 4 DESC LIMIT 8`],
  ['③ 요일별 손님 수 (평균)', `
    SELECT weekday AS 요일, COUNT(*) AS 일수,
           ROUND(AVG(visitors)) AS 평균손님, ROUND(AVG(dine_in_count)) AS 매장,
           ROUND(AVG(takeout_count)) AS 테이크아웃
    FROM cafe_visitors WHERE visitors > 0
    GROUP BY weekday
    ORDER BY array_position(ARRAY['월','화','수','목','금','토','일'], weekday)`],
  ['④ 손님 리뷰 요약', `
    SELECT source AS 채널, COUNT(*) AS 건수, ROUND(AVG(rating),2) AS 평균평점
    FROM cafe_reviews GROUP BY source ORDER BY 2 DESC`],
  ['⑤ 재고 부족(안전재고 이하) → 발주 필요', `
    SELECT item_name AS 품목, current_stock AS 현재고, safety_stock AS 안전재고,
           unit AS 단위, supplier AS 거래처, last_ordered_at AS 최근발주
    FROM cafe_inventory WHERE current_stock <= safety_stock ORDER BY category`],
  ['⑥ 발주 상태별 집계', `
    SELECT status AS 상태, COUNT(*) AS 건수, SUM(amount) AS 금액
    FROM cafe_purchase_orders GROUP BY status ORDER BY 2 DESC`],
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  for (let i = 1; i <= 5; i++) {
    try { await c.connect(); break; } catch (e) { if (i === 5) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
  for (const [title, sql] of Q) {
    const r = await c.query(sql);
    console.log(`\n${title}`);
    console.table(r.rows);
  }
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
