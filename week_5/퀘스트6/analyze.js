// 신메뉴 기회 분석 — node analyze.js
require('dotenv').config();
const { Client } = require('pg');

const Q = [
  ['A. 카테고리별 매출 비중 & 마진', `
    SELECT m.category AS 구분, SUM(s.qty) AS 판매량, SUM(s.amount) AS 매출,
           ROUND(100.0*SUM(s.amount)/SUM(SUM(s.amount)) OVER (),1) AS "매출비중%",
           ROUND(100.0*SUM(s.qty*(m.price-m.cost))/SUM(s.amount),1) AS "마진율%",
           SUM(s.qty*(m.price-m.cost)) AS 마진액
    FROM cafe_menu_sales s JOIN cafe_menus m ON m.id=s.menu_id
    GROUP BY m.category ORDER BY 3 DESC`],
  ['B. 메뉴별 마진 순위 (하위 포함 전체)', `
    SELECT m.name AS 메뉴, m.price AS 가격, m.price-m.cost AS 개당마진,
           ROUND(100.0*(m.price-m.cost)/m.price,1) AS "마진율%",
           SUM(s.qty) AS 판매량, SUM(s.qty*(m.price-m.cost)) AS 총마진
    FROM cafe_menu_sales s JOIN cafe_menus m ON m.id=s.menu_id
    GROUP BY m.id ORDER BY 6 DESC`],
  ['C. 논커피 vs 커피 (더운 날 폭염일 기준)', `
    SELECT d.weather AS 날씨, m.category AS 구분,
           ROUND(AVG(s.qty),1) AS 일평균판매
    FROM cafe_menu_sales s
    JOIN cafe_menus m ON m.id=s.menu_id
    JOIN cafe_daily_sales d ON d.sale_date=s.sale_date
    WHERE m.category='논커피' AND d.is_closed=false
    GROUP BY d.weather, m.category ORDER BY 3 DESC`],
  ['D. 최근 30일 vs 이전 30일 메뉴 성장률', `
    WITH recent AS (
      SELECT menu_id, SUM(qty) q FROM cafe_menu_sales
      WHERE sale_date > CURRENT_DATE - 31 GROUP BY menu_id),
    prior AS (
      SELECT menu_id, SUM(qty) q FROM cafe_menu_sales
      WHERE sale_date BETWEEN CURRENT_DATE - 61 AND CURRENT_DATE - 32 GROUP BY menu_id)
    SELECT m.name AS 메뉴, p.q AS 이전30일, r.q AS 최근30일,
           ROUND(100.0*(r.q-p.q)/NULLIF(p.q,0),1) AS "성장률%"
    FROM cafe_menus m JOIN recent r ON r.menu_id=m.id JOIN prior p ON p.menu_id=m.id
    ORDER BY 4 DESC`],
  ['E. 시간대(피크) 분포 — 평일 아침/점심 수요', `
    SELECT peak_hour AS 피크시간, COUNT(*) AS 일수, ROUND(AVG(visitors)) AS 평균손님
    FROM cafe_visitors WHERE visitors>0
    GROUP BY peak_hour ORDER BY 2 DESC`],
  ['F. 저평점(1~3점) 리뷰 — 불만 포인트', `
    SELECT rating AS 평점, source AS 채널, menu AS 메뉴, content AS 내용
    FROM cafe_reviews WHERE rating<=3 ORDER BY rating`],
  ['G. 객단가', `
    SELECT ROUND(AVG(revenue::numeric/NULLIF(order_count,0))) AS 객단가,
           ROUND(AVG(revenue::numeric/NULLIF(visitors,0))) AS "1인당매출"
    FROM cafe_daily_sales WHERE is_closed=false`],
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  for (let i=1;i<=5;i++){ try{ await c.connect(); break; } catch(e){ if(i===5) throw e; await new Promise(r=>setTimeout(r,1500)); } }
  for (const [t, sql] of Q) { const r = await c.query(sql); console.log(`\n${t}`); console.table(r.rows); }
  await c.end();
})().catch(e=>{ console.error(e); process.exit(1); });
