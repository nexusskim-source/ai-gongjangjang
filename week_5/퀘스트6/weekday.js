// 요일별 이벤트 설계용 분석 — node weekday.js
require('dotenv').config();
const { Client } = require('pg');
const ORD = `array_position(ARRAY['월','화','수','목','금','토','일'], weekday)`;

const Q = [
  ['1. 요일별 손님·매출·객단가', `
    SELECT weekday AS 요일, ROUND(AVG(visitors)) AS 평균손님,
           ROUND(AVG(revenue)) AS 평균매출,
           ROUND(AVG(revenue::numeric/NULLIF(order_count,0))) AS 객단가
    FROM cafe_daily_sales WHERE is_closed=false
    GROUP BY weekday ORDER BY ${ORD}`],
  ['2. 요일별 테이크아웃 비중', `
    SELECT weekday AS 요일, ROUND(AVG(dine_in_count)) AS 매장, ROUND(AVG(takeout_count)) AS 테이크아웃,
           ROUND(100.0*SUM(takeout_count)/SUM(visitors),1) AS "테이크아웃%"
    FROM cafe_visitors WHERE visitors>0 GROUP BY weekday ORDER BY ${ORD}`],
  ['3. 요일 × 카테고리 일평균 판매량', `
    SELECT d.weekday AS 요일,
      ROUND(AVG(CASE WHEN m.category='커피'   THEN s.qty END),1) AS 커피,
      ROUND(AVG(CASE WHEN m.category='논커피' THEN s.qty END),1) AS 논커피,
      ROUND(AVG(CASE WHEN m.category='디저트' THEN s.qty END),1) AS 디저트,
      ROUND(AVG(CASE WHEN m.category='사이드' THEN s.qty END),1) AS 사이드,
      ROUND(AVG(CASE WHEN m.category='세트'   THEN s.qty END),1) AS 세트
    FROM cafe_menu_sales s
    JOIN cafe_menus m ON m.id=s.menu_id
    JOIN cafe_daily_sales d ON d.sale_date=s.sale_date
    GROUP BY d.weekday ORDER BY ${ORD}`],
  ['4. 요일별 피크 시간대', `
    SELECT weekday AS 요일, peak_hour AS 피크, COUNT(*) AS 일수
    FROM cafe_visitors WHERE visitors>0
    GROUP BY weekday, peak_hour ORDER BY ${ORD}, 3 DESC`],
  ['5. 요일별 세트 부착률(주문 대비 세트 비율)', `
    SELECT d.weekday AS 요일, SUM(s.qty) AS 세트판매, SUM(d.order_count) AS 주문수,
           ROUND(100.0*SUM(s.qty)/SUM(d.order_count),1) AS "세트부착률%"
    FROM cafe_menu_sales s
    JOIN cafe_menus m ON m.id=s.menu_id AND m.category='세트'
    JOIN cafe_daily_sales d ON d.sale_date=s.sale_date
    GROUP BY d.weekday ORDER BY ${ORD}`],
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  for (let i=1;i<=5;i++){ try{ await c.connect(); break; } catch(e){ if(i===5) throw e; await new Promise(r=>setTimeout(r,1500)); } }
  for (const [t, sql] of Q) { const r = await c.query(sql); console.log(`\n${t}`); console.table(r.rows); }
  await c.end();
})().catch(e=>{ console.error(e); process.exit(1); });
