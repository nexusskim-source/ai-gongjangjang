// ☕ Day On(데이온) 카페 데이터 분석 → CSV 리서치 결과 추출
// 실행: cd week_6/퀘스트3 && node export-csv.js
//
// 원본 데이터: Supabase cafe_* 테이블 7개 (week_5/퀘스트6에서 생성)
// 출력: 이 폴더에 분석 결과 CSV 9개
//
// ※ 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM을 붙여 저장한다.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const WD = `array_position(ARRAY['월','화','수','목','금','토','일'], weekday)`;

// ─── 분석 쿼리 9종 ───────────────────────────────────────
const REPORTS = [
  ['01_핵심요약지표', `
    SELECT '분석기간' AS 지표, MIN(sale_date)::text || ' ~ ' || MAX(sale_date)::text AS 값 FROM cafe_daily_sales
    UNION ALL SELECT '총 영업일수', COUNT(*)::text || '일' FROM cafe_daily_sales WHERE is_closed=false
    UNION ALL SELECT '정기휴무일수', COUNT(*)::text || '일' FROM cafe_daily_sales WHERE is_closed=true
    UNION ALL SELECT '총매출', TO_CHAR(SUM(revenue),'FM999,999,999') || '원' FROM cafe_daily_sales
    UNION ALL SELECT '일평균 매출', TO_CHAR(ROUND(AVG(revenue)),'FM999,999,999') || '원' FROM cafe_daily_sales WHERE is_closed=false
    UNION ALL SELECT '일평균 손님수', ROUND(AVG(visitors),1)::text || '명' FROM cafe_daily_sales WHERE is_closed=false
    UNION ALL SELECT '평균 객단가', TO_CHAR(ROUND(AVG(revenue::numeric/NULLIF(order_count,0))),'FM999,999') || '원' FROM cafe_daily_sales WHERE is_closed=false
    UNION ALL SELECT '총 판매수량', SUM(qty)::text || '개' FROM cafe_menu_sales
    UNION ALL SELECT '총 마진액', TO_CHAR(SUM(s.qty*(m.price-m.cost)),'FM999,999,999') || '원' FROM cafe_menu_sales s JOIN cafe_menus m ON m.id=s.menu_id
    UNION ALL SELECT '평균 마진율', ROUND(100.0*SUM(s.qty*(m.price-m.cost))/SUM(s.amount),1)::text || '%' FROM cafe_menu_sales s JOIN cafe_menus m ON m.id=s.menu_id
    UNION ALL SELECT '리뷰 평균평점', ROUND(AVG(rating),2)::text || '점 (' || COUNT(*)::text || '건)' FROM cafe_reviews
    UNION ALL SELECT '재고부족 품목수', COUNT(*)::text || '개' FROM cafe_inventory WHERE current_stock <= safety_stock`],

  ['02_일별매출', `
    SELECT sale_date AS 날짜, weekday AS 요일, weather AS 날씨,
           CASE WHEN is_closed THEN '휴무' ELSE '영업' END AS 영업여부,
           visitors AS 손님수, order_count AS 주문건수, revenue AS 매출액,
           CASE WHEN order_count>0 THEN ROUND(revenue::numeric/order_count) ELSE 0 END AS 객단가
    FROM cafe_daily_sales ORDER BY sale_date`],

  ['03_메뉴별_판매량_마진', `
    SELECT m.name AS 메뉴명, m.category AS 카테고리,
           CASE WHEN m.is_signature THEN 'O' ELSE '' END AS 시그니처,
           m.price AS 판매가, m.cost AS 원가, m.price-m.cost AS 개당마진,
           ROUND(100.0*(m.price-m.cost)/m.price,1) AS "마진율(%)",
           SUM(s.qty) AS 총판매량, SUM(s.amount) AS 총매출,
           SUM(s.qty*(m.price-m.cost)) AS 총마진,
           ROUND(100.0*SUM(s.amount)/SUM(SUM(s.amount)) OVER (),1) AS "매출비중(%)"
    FROM cafe_menu_sales s JOIN cafe_menus m ON m.id=s.menu_id
    GROUP BY m.id ORDER BY 10 DESC`],

  ['04_카테고리별_매출_마진', `
    SELECT m.category AS 카테고리, COUNT(DISTINCT m.id) AS 메뉴수,
           SUM(s.qty) AS 총판매량, SUM(s.amount) AS 총매출,
           ROUND(100.0*SUM(s.amount)/SUM(SUM(s.amount)) OVER (),1) AS "매출비중(%)",
           SUM(s.qty*(m.price-m.cost)) AS 총마진,
           ROUND(100.0*SUM(s.qty*(m.price-m.cost))/SUM(s.amount),1) AS "마진율(%)"
    FROM cafe_menu_sales s JOIN cafe_menus m ON m.id=s.menu_id
    GROUP BY m.category ORDER BY 4 DESC`],

  ['05_요일별_손님_매출', `
    SELECT v.weekday AS 요일, COUNT(*) AS 영업일수,
           ROUND(AVG(v.visitors),1) AS 평균손님수,
           ROUND(AVG(v.dine_in_count),1) AS 평균매장,
           ROUND(AVG(v.takeout_count),1) AS 평균테이크아웃,
           ROUND(100.0*SUM(v.takeout_count)/SUM(v.visitors),1) AS "테이크아웃비중(%)",
           ROUND(AVG(d.revenue)) AS 평균매출,
           ROUND(AVG(d.revenue::numeric/NULLIF(d.order_count,0))) AS 평균객단가
    FROM cafe_visitors v JOIN cafe_daily_sales d ON d.sale_date=v.visit_date
    WHERE v.visitors > 0
    GROUP BY v.weekday ORDER BY ${WD.replace(/weekday/g, 'v.weekday')}`],

  ['06_요일별_카테고리_판매', `
    SELECT d.weekday AS 요일,
      ROUND(AVG(CASE WHEN m.category='커피'   THEN s.qty END),1) AS 커피,
      ROUND(AVG(CASE WHEN m.category='논커피' THEN s.qty END),1) AS 논커피,
      ROUND(AVG(CASE WHEN m.category='디저트' THEN s.qty END),1) AS 디저트,
      ROUND(AVG(CASE WHEN m.category='사이드' THEN s.qty END),1) AS 사이드,
      ROUND(AVG(CASE WHEN m.category='세트'   THEN s.qty END),1) AS 세트
    FROM cafe_menu_sales s
    JOIN cafe_menus m ON m.id=s.menu_id
    JOIN cafe_daily_sales d ON d.sale_date=s.sale_date
    GROUP BY d.weekday ORDER BY ${WD.replace(/weekday/g, 'd.weekday')}`],

  ['07_날씨별_매출영향', `
    SELECT weather AS 날씨, COUNT(*) AS 일수,
           ROUND(AVG(visitors),1) AS 평균손님수, ROUND(AVG(revenue)) AS 평균매출,
           ROUND(100.0*AVG(revenue)/(SELECT AVG(revenue) FROM cafe_daily_sales WHERE weather='맑음') - 100, 1)
             AS "맑은날대비(%)"
    FROM cafe_daily_sales WHERE is_closed=false
    GROUP BY weather ORDER BY 4 DESC`],

  ['08_리뷰분석', `
    SELECT source AS 채널, COUNT(*) AS 리뷰수, ROUND(AVG(rating),2) AS 평균평점,
           COUNT(*) FILTER (WHERE rating=5) AS "5점",
           COUNT(*) FILTER (WHERE rating=4) AS "4점",
           COUNT(*) FILTER (WHERE rating=3) AS "3점",
           COUNT(*) FILTER (WHERE rating<=2) AS "2점이하"
    FROM cafe_reviews GROUP BY source
    UNION ALL
    SELECT '── 전체 ──', COUNT(*), ROUND(AVG(rating),2),
           COUNT(*) FILTER (WHERE rating=5), COUNT(*) FILTER (WHERE rating=4),
           COUNT(*) FILTER (WHERE rating=3), COUNT(*) FILTER (WHERE rating<=2)
    FROM cafe_reviews`],

  // ─── 고객의 소리 (리뷰 원문) ───
  ['09_고객의소리_리뷰원문', `
    SELECT review_date AS 작성일, source AS 채널, author AS 작성자, rating AS 평점,
           COALESCE(menu,'(메뉴 언급 없음)') AS 언급메뉴,
           CASE WHEN rating>=4 THEN '긍정' WHEN rating=3 THEN '중립' ELSE '불만' END AS 구분,
           content AS 리뷰내용
    FROM cafe_reviews ORDER BY review_date`],

  ['10_고객의소리_불만사항', `
    SELECT review_date AS 작성일, source AS 채널, rating AS 평점,
           COALESCE(menu,'(메뉴 언급 없음)') AS 언급메뉴, content AS 리뷰내용
    FROM cafe_reviews WHERE rating <= 3 ORDER BY rating, review_date`],

  ['11_메뉴별_리뷰반응', `
    SELECT menu AS 언급메뉴, COUNT(*) AS 언급횟수, ROUND(AVG(rating),2) AS 평균평점,
           COUNT(*) FILTER (WHERE rating>=4) AS 긍정,
           COUNT(*) FILTER (WHERE rating<=3) AS "중립·불만"
    FROM cafe_reviews WHERE menu IS NOT NULL
    GROUP BY menu ORDER BY 2 DESC, 3 DESC`],

  ['12_재고_발주현황', `
    SELECT i.item_name AS 품목, i.category AS 분류, i.unit AS 단위,
           i.current_stock AS 현재고, i.safety_stock AS 안전재고,
           CASE WHEN i.current_stock <= i.safety_stock THEN '발주필요' ELSE '정상' END AS 상태,
           i.unit_cost AS 단가, i.supplier AS 거래처, i.last_ordered_at AS 최근발주일,
           COALESCE(p.발주건수,0) AS 누적발주건수, COALESCE(p.발주금액,0) AS 누적발주금액
    FROM cafe_inventory i
    LEFT JOIN (SELECT item_id, COUNT(*) AS 발주건수, SUM(amount) AS 발주금액
               FROM cafe_purchase_orders GROUP BY item_id) p ON p.item_id = i.id
    ORDER BY (i.current_stock <= i.safety_stock) DESC, i.category, i.item_name`],
];

// ─── CSV 변환 ───────────────────────────────────────────
function toCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    // pg는 DATE를 JS Date로 준다 → 로컬 기준 YYYY-MM-DD 로 되돌린다
    const s = v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
      : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  // Supabase pooler 첫 연결 간헐 실패 → 재시도
  for (let i = 1; i <= 5; i++) {
    try { await client.connect(); break; }
    catch (e) { if (i === 5) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  console.log('✅ Supabase 연결됨\n');

  for (const [name, sql] of REPORTS) {
    const r = await client.query(sql);
    const file = path.join(__dirname, `${name}.csv`);
    fs.writeFileSync(file, '﻿' + toCsv(r.rows), 'utf8'); // BOM → 엑셀 한글 정상
    console.log(`  ${name}.csv  (${r.rows.length}행)`);
  }

  await client.end();
  console.log('\n✅ CSV 9개 생성 완료');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
