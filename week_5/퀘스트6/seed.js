// ☕ Day On (데이온) 카페 운영 DB 시드 스크립트
// 실행: node seed.js
// 기간: 2026-04-14 ~ 2026-07-12 (90일)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// 재현 가능한 난수 (고정 시드)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260713);
const jitter = (base, pct) => base * (1 + (rand() * 2 - 1) * pct);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const fmt = (d) => d.toISOString().slice(0, 10);

// ─────────────────────────────────────────────
// 1) 메뉴 마스터 (my_cafe.md 라인업 기반)
// ─────────────────────────────────────────────
const MENUS = [
  // name, category, price, cost, signature, 판매 가중치(인기도)
  ['아메리카노',            '커피',   4000, 1100, false, 100],
  ['카페라떼',              '커피',   4500, 1500, false,  62],
  ['너츠라떼',              '커피',   5500, 1900, true,   88], // 간판 메뉴
  ['피칸 아인슈페너',       '커피',   6500, 2300, true,   45], // 이색 시그니처
  ['헤이즐넛 콜드브루',     '커피',   5500, 1700, false,  38],
  ['디카페인 아메리카노',   '커피',   4500, 1300, false,  20],
  ['흑임자 라떼',           '논커피', 5800, 2000, false,  24],
  ['자몽에이드',            '논커피', 5500, 1600, false,  30],
  ['제철 과일 티',          '논커피', 5500, 1500, false,  18],
  ['피칸파이',              '디저트', 5000, 1700, true,   70], // 재방문 이유
  ['바스크 치즈케이크',     '디저트', 6000, 2100, false,  33],
  ['올리브 치아바타',       '사이드', 4000, 1200, false,  28],
  ['치아바타 샌드위치(리코타바질)', '사이드', 7500, 2900, false, 30],
  ['치아바타 샌드위치(햄치즈)',     '사이드', 8500, 3300, false, 26],
  ['너츠라떼 + 피칸파이 세트',      '세트',   8500, 3400, true,  75], // 간판 세트
  ['피칸 아인슈페너 + 피칸파이 세트','세트',   9000, 3800, true,  40],
];

// ─────────────────────────────────────────────
// 2) 재고 마스터
// ─────────────────────────────────────────────
const INVENTORY = [
  // item, category, unit, 현재고, 안전재고, 단가, 거래처
  ['하우스 블렌드 원두',   '원두',     'kg',  8.5,  6.0, 28000, '골목로스터스'],
  ['디카페인 원두',        '원두',     'kg',  2.0,  2.0, 32000, '골목로스터스'],
  ['우유(1L)',             '유제품',   'L',  24.0, 20.0,  2400, '데일리유업'],
  ['생크림',               '유제품',   'L',   5.0,  4.0,  6800, '데일리유업'],
  ['리코타 치즈',          '유제품',   'kg',  1.2,  1.5,  9500, '데일리유업'],
  ['슬라이스 치즈',        '유제품',   '팩',  6.0,  5.0,  4200, '데일리유업'],
  ['피칸(생)',             '견과',     'kg',  3.2,  3.0, 34000, '너트하우스'],
  ['헤이즐넛 시럽',        '견과',     '병',  4.0,  3.0,  9800, '너트하우스'],
  ['너츠 페이스트',        '견과',     'kg',  2.5,  2.0, 26000, '너트하우스'],
  ['치아바타(냉동)',       '베이커리', '개', 40.0, 40.0,  1300, '골목베이커리'],
  ['피칸파이 시트',        '베이커리', '개', 22.0, 25.0,  2100, '골목베이커리'],
  ['버터',                 '베이커리', 'kg',  2.0,  2.0, 12000, '골목베이커리'],
  ['자몽청',               '부재료',   'kg',  3.0,  2.5,  8500, '한들식자재'],
  ['흑임자 페이스트',      '부재료',   'kg',  1.5,  1.0, 18000, '한들식자재'],
  ['바질 페스토',          '부재료',   'kg',  0.8,  1.0, 15000, '한들식자재'],
  ['테이크아웃컵(12oz)',   '부자재',   '개', 320,  300,     90, '패키지마켓'],
  ['테이크아웃컵(16oz)',   '부자재',   '개', 260,  250,    110, '패키지마켓'],
  ['컵홀더',               '부자재',   '개', 400,  300,     45, '패키지마켓'],
  ['종이 빨대',            '부자재',   '개', 180,  200,     22, '패키지마켓'],
  ['냅킨',                 '부자재',   '개', 900,  500,     11, '패키지마켓'],
];

// ─────────────────────────────────────────────
// 3) 손님 리뷰 (평점 4~5 위주 + 현실적인 불만)
// ─────────────────────────────────────────────
const REVIEWS = [
  ['네이버',     '민트초코러버', 5, '너츠라떼 + 피칸파이 세트', '골목에 이런 데가 있는 줄 몰랐어요. 너츠라떼 고소하고 피칸파이 데워주셔서 더 맛있었습니다. 세트로 8,500원이면 착해요.'],
  ['카카오맵',   'jiwon_k',      5, '너츠라떼',            '동네에 이런 카페 생겨서 너무 좋아요. 식물 많고 원목이라 마음이 편해집니다. 너츠라떼 진짜 시그니처 맞네요.'],
  ['구글',       'Sarah L.',     4, '피칸 아인슈페너',      '피칸 크림이 올라간 아인슈페너가 독특해요. 사진도 잘 나옵니다. 다만 좌석이 적어서 대기했어요.'],
  ['네이버',     '골목산책러',   5, '피칸파이',            '피칸파이 먹으러 일부러 옵니다. 겉은 바삭 속은 촉촉. 커피랑 같이 먹으면 진짜 쉬어지는 느낌.'],
  ['카카오맵',   '동네주민9',    4, '아메리카노',          '집 앞이라 자주 갑니다. 아메리카노 4천원인데 산미 적당하고 좋아요. 조용해서 책 읽기 좋음.'],
  ['인스타그램', 'cafe_hunter_',  5, '피칸 아인슈페너',     '데이온 다녀왔어요 🌿 골목 안 작은 정원 컨셉 진짜예요. 피칸 아인슈페너 비주얼 미쳤습니다.'],
  ['네이버',     '토닥토닥',     5, '너츠라떼',            '이름처럼 하루가 켜지는 느낌. 사장님도 친절하시고 식물 관리가 잘 되어 있어요.'],
  ['구글',       '이현우',       3, '치아바타 샌드위치(햄치즈)', '샌드위치는 무난했는데 8,500원은 살짝 비싼 느낌. 커피는 좋았어요.'],
  ['카카오맵',   'yeeun.p',      5, '너츠라떼 + 피칸파이 세트', '세트 조합이 정말 잘 어울려요. 고소한 게 이어지는 느낌이 뭔지 알겠어요.'],
  ['네이버',     '주말산책',     4, '올리브 치아바타',      '빵도 맛있어요. 커피랑 페어링 추천해주신 대로 먹었는데 좋았습니다.'],
  ['네이버',     '카페투어중',   5, '피칸파이',            '피칸파이가 이 집 정체성. 다른 데선 이 맛 안 나요. 재방문 확정.'],
  ['카카오맵',   '한결',         2, null,                  '주차가 아예 안 돼요. 골목이라 차 가져가면 고생합니다. 맛은 좋은데 접근성이 아쉬워요.'],
  ['구글',       'Minji C.',     5, '흑임자 라떼',         '흑임자 라떼도 고소해서 좋아요. 견과 테마랑 잘 맞습니다. 인테리어가 정말 편안해요.'],
  ['인스타그램', 'daily_coffee.k', 4, '헤이즐넛 콜드브루',  '콜드브루 시원하고 헤이즐넛 향이 은은해요. 테이크아웃으로 자주 사갑니다.'],
  ['네이버',     '워킹맘s',      5, '너츠라떼',            '아이 데리고 갔는데 눈치 안 주셔서 감사했어요. 조용하고 따뜻한 동네 사랑방 맞습니다.'],
  ['카카오맵',   '재방문의신',   5, '피칸파이',            '벌써 다섯 번째 방문. 피칸파이 없으면 안 됩니다. 품절될 때가 있어서 미리 전화하고 가요.'],
  ['구글',       'Tom H.',       4, '아메리카노',          'Quiet neighborhood cafe with lots of plants. Coffee is solid and the pecan pie is excellent.'],
  ['네이버',     '조용한오후',   5, '제철 과일 티',        '커피 못 마시는 사람도 만족할 메뉴가 있어서 좋아요. 티도 향이 좋습니다.'],
  ['카카오맵',   'seoyeon__',    4, '바스크 치즈케이크',    '치즈케이크도 맛있는데 저는 피칸파이가 더 좋았어요. 취향 차이일 듯.'],
  ['네이버',     '골목보석찾기', 5, '너츠라떼 + 피칸파이 세트', '진짜 골목 속 숨은 보석. 친구 데려왔더니 다들 좋아했어요.'],
  ['인스타그램', 'plant_lover_c', 5, null,                 '식물 좋아하는 사람은 무조건 좋아할 공간. 창가 자리 햇빛 들어올 때 최고예요 🌿'],
  ['구글',       'Daniel P.',    3, '자몽에이드',          '에이드는 평범했어요. 대신 커피랑 디저트는 확실히 잘합니다.'],
  ['카카오맵',   '퇴근길커피',   5, '아메리카노',          '퇴근하고 들르는 게 낙입니다. 늦게까지 안 해서 아쉽지만 그만큼 여유로워요.'],
  ['네이버',     '브런치조아',   4, '치아바타 샌드위치(리코타바질)', '리코타 바질 샌드위치 신선하고 좋아요. 점심으로 딱입니다.'],
  ['네이버',     '고소한거좋아', 5, '너츠라떼',            '너츠라떼 한 잔에 기분이 풀립니다. 이름값 하는 시그니처.'],
  ['카카오맵',   'hyunsoo_j',    4, '피칸 아인슈페너',      '비주얼 때문에 시켰는데 맛도 좋아요. 6,500원 값은 합니다.'],
  ['구글',       'Yuna K.',      5, '피칸파이',            '피칸파이 따뜻하게 데워 주는 게 포인트. 아이스 아메리카노랑 조합 최고.'],
  ['네이버',     '느긋한하루',   5, null,                  '"진짜 쉬어지는" 이라는 말이 뭔지 알겠어요. 시끄럽지 않고 음악도 좋습니다.'],
  ['카카오맵',   '까칠한리뷰어', 3, '카페라떼',            '라떼는 그냥 그랬어요. 시그니처 메뉴를 시키는 게 맞는 것 같습니다.'],
  ['인스타그램', 'weekend_cafe_', 5, '너츠라떼 + 피칸파이 세트', '데이온 세트 강추 🌰 사장님이 원두 설명도 해주셔서 좋았어요.'],
  ['네이버',     '동네탐험가',   5, '올리브 치아바타',      '커피 맛집인데 빵도 잘해요. 치아바타 사가는 사람 많더라고요.'],
  ['구글',       'Rachel M.',    4, '헤이즐넛 콜드브루',    'Cozy spot. Cold brew was smooth. Seating is limited so come early.'],
  ['카카오맵',   '오후세시',     5, '너츠라떼',            '오후에 가면 햇빛이 예쁘게 들어와요. 사진 찍기도 좋고 쉬기도 좋고.'],
  ['네이버',     '단골되는중',   5, '피칸파이',            '주 2회 방문 중. 피칸파이 + 아메리카노 고정 조합입니다.'],
  ['카카오맵',   'jaehyun.lee',  4, '흑임자 라떼',         '흑임자 라떼 달지 않아서 좋아요. 다만 대기 시간이 좀 있었습니다.'],
  ['네이버',     '봄날의산책',   5, null,                  '골목 들어서면서부터 기분이 좋아지는 카페. 인테리어가 진심입니다.'],
  ['구글',       'Sunwoo B.',    5, '피칸 아인슈페너',     '시그니처 두 개 다 먹어봤는데 아인슈페너 쪽이 더 취향이었어요.'],
  ['인스타그램', 'nutty_days',    5, '너츠라떼',           '견과 테마 컨셉 확실합니다. 커피부터 디저트까지 결이 이어져요 🌰☕'],
  ['카카오맵',   '무던한사람',   4, '아메리카노',          '가격 대비 만족. 동네에서 이 정도 퀄리티면 자주 옵니다.'],
  ['네이버',     '커피는사랑',   5, '너츠라떼 + 피칸파이 세트', '세트 시키면 실패 없어요. 남녀노소 좋아할 맛.'],
  ['네이버',     '한숨돌리기',   5, null,                  '슬로건대로 정말 한 숨 돌리게 되는 곳. 조용한 카페 찾는 분들께 추천.'],
  ['구글',       'Chris W.',     4, '치아바타 샌드위치(햄치즈)', 'Good sandwich, great coffee. A bit pricey but worth it.'],
  ['카카오맵',   '디저트헌터',   5, '바스크 치즈케이크',    '치즈케이크 겉 탄맛 적당하고 속 촉촉. 피칸파이랑 같이 시켜서 나눠 먹었어요.'],
  ['네이버',     '오늘도데이온', 5, '너츠라떼',            '이름처럼 하루가 켜집니다. 아침에 들르면 그날 기분이 달라요.'],
  ['인스타그램', 'quiet_corner__', 4, '제철 과일 티',      '커피 안 마시는 날엔 과일 티. 향 좋고 자극적이지 않아요.'],
  ['카카오맵',   '솔직후기',     3, '피칸파이',            '피칸파이는 맛있는데 5,000원이면 조금 비싼 듯. 그래도 재방문 의사 있음.'],
  ['네이버',     '식물집사',     5, null,                  '식물 상태 보면 사장님 정성이 보여요. 공간에 애정이 느껴지는 카페.'],
  ['구글',       'Nara S.',      5, '너츠라떼 + 피칸파이 세트', '데이트 코스로 좋아요. 시끄럽지 않아서 대화하기 편합니다.'],
  ['카카오맵',   '점심커피',     4, '자몽에이드',          '더운 날 자몽에이드 시원하고 좋았어요. 상큼합니다.'],
  ['네이버',     '재방문각',     5, '피칸 아인슈페너',      '한 번 오면 계속 오게 되는 집. 사장님 응대가 편안해요.'],
  ['카카오맵',   '주말러',       2, null,                  '주말에 자리가 없어서 그냥 돌아왔어요. 좌석 확장 좀 해주세요...'],
  ['네이버',     '고요한시간',   5, '아메리카노',          '노트북 하기 좋진 않지만 쉬러 가기엔 최고. 컨셉이 명확해서 좋습니다.'],
  ['구글',       'Hana Y.',      5, '피칸파이',            '피칸파이 때문에 재방문. 이 동네 최고 디저트라고 생각해요.'],
  ['인스타그램', 'seoul_alley_cafe', 5, null,              '숨은 골목 카페 시리즈 — 데이온. 인테리어 취향 저격입니다 🌿'],
  ['카카오맵',   '느림보',       4, '헤이즐넛 콜드브루',    '콜드브루 진하고 좋아요. 얼음 녹아도 안 밍밍합니다.'],
  ['네이버',     '커피한잔의여유', 5, '너츠라떼',          '고소한 라떼 찾는 분들 여기가 정답. 다른 데 못 갑니다.'],
  ['구글',       'Ben K.',       4, '올리브 치아바타',      'Nice bread, friendly owner. Would come back.'],
  ['카카오맵',   '동네한바퀴',   5, '치아바타 샌드위치(리코타바질)', '브런치로 먹었는데 든든하고 신선했어요. 커피랑 세트로 먹으면 좋을 듯.'],
  ['네이버',     '하루의시작',   5, null,                  '아침 일찍 열어주셔서 감사해요. 출근 전 들르는 루틴이 생겼습니다.'],
  ['카카오맵',   '리뷰왕김씨',   4, '흑임자 라떼',         '견과·곡물 계열 좋아하면 여기 메뉴 다 취향일 거예요.'],
];

// ─────────────────────────────────────────────
// 시드 실행
// ─────────────────────────────────────────────
async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Supabase pooler 첫 연결 간헐 실패 → 재시도
  for (let i = 1; i <= 5; i++) {
    try { await client.connect(); break; }
    catch (e) {
      if (i === 5) throw e;
      console.log(`  연결 재시도 ${i}/5 (${e.code || e.message})`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.log('✅ Supabase 연결됨');

  // 스키마 생성
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
  console.log('✅ 테이블 7개 생성 완료');

  // 1) 메뉴
  const menuIds = {};
  for (const [name, category, price, cost, sig] of MENUS) {
    const r = await client.query(
      `INSERT INTO cafe_menus (name, category, price, cost, is_signature)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, category, price, cost, sig]
    );
    menuIds[name] = r.rows[0].id;
  }
  console.log(`✅ 메뉴 ${MENUS.length}건`);

  // 2) 재고
  const invIds = {};
  for (const [item, category, unit, stock, safety, cost, supplier] of INVENTORY) {
    const r = await client.query(
      `INSERT INTO cafe_inventory
       (item_name, category, unit, current_stock, safety_stock, unit_cost, supplier)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [item, category, unit, stock, safety, cost, supplier]
    );
    invIds[item] = r.rows[0].id;
  }
  console.log(`✅ 재고 ${INVENTORY.length}건`);

  // 3) 일별 매출 + 메뉴별 판매량 + 요일별 손님 수
  const START = new Date('2026-04-14T00:00:00Z');
  const DAYS = 90;
  // 요일별 기본 방문객 (주택가 골목 카페 — 주말/금요일 강세)
  const BASE_BY_DOW = { 0: 96, 1: 54, 2: 58, 3: 61, 4: 64, 5: 84, 6: 112 }; // 일~토
  const WEATHERS = ['맑음', '맑음', '맑음', '흐림', '흐림', '비', '폭염'];

  let totalRevenue = 0, menuRows = 0;

  for (let d = 0; d < DAYS; d++) {
    const date = new Date(START.getTime() + d * 86400000);
    const dow = date.getUTCDay();
    const dateStr = fmt(date);
    const weekday = WEEKDAYS[dow];

    // 매월 첫째 주 월요일 정기휴무
    const isClosed = dow === 1 && date.getUTCDate() <= 7;
    if (isClosed) {
      await client.query(
        `INSERT INTO cafe_daily_sales (sale_date, weekday, visitors, order_count, revenue, weather, is_closed)
         VALUES ($1,$2,0,0,0,$3,TRUE)`, [dateStr, weekday, '휴무']
      );
      await client.query(
        `INSERT INTO cafe_visitors (visit_date, weekday, visitors, dine_in_count, takeout_count, peak_hour)
         VALUES ($1,$2,0,0,0,NULL)`, [dateStr, weekday]
      );
      continue;
    }

    const weather = pick(WEATHERS);
    const weatherFactor = weather === '비' ? 0.76 : weather === '폭염' ? 0.9 : weather === '흐림' ? 0.97 : 1.0;
    const growth = 1 + (d / DAYS) * 0.18; // 90일간 입소문으로 +18% 성장

    const visitors = Math.max(20, Math.round(jitter(BASE_BY_DOW[dow] * growth * weatherFactor, 0.13)));
    const orderCount = Math.max(15, Math.round(visitors * jitter(0.86, 0.06)));
    const items = Math.round(orderCount * jitter(1.55, 0.08)); // 주문당 평균 1.55개

    // 메뉴 가중 배분 (주말엔 세트/디저트 ↑, 평일 낮엔 아메리카노·샌드위치 ↑)
    const isWeekend = dow === 0 || dow === 6;
    const weights = MENUS.map(([name, cat, , , , w]) => {
      let x = w;
      if (isWeekend && (cat === '세트' || cat === '디저트')) x *= 1.35;
      if (!isWeekend && cat === '커피') x *= 1.15;
      if (!isWeekend && cat === '사이드') x *= 1.25;
      if (weather === '폭염' && (name === '헤이즐넛 콜드브루' || name === '자몽에이드')) x *= 1.6;
      return x * jitter(1, 0.18);
    });
    const wsum = weights.reduce((a, b) => a + b, 0);

    const qtys = MENUS.map((_, i) => Math.round((items * weights[i]) / wsum));
    let revenue = 0;
    for (let i = 0; i < MENUS.length; i++) {
      const qty = qtys[i];
      if (qty <= 0) continue;
      const [name, , price] = MENUS[i];
      const amount = qty * price;
      revenue += amount;
      await client.query(
        `INSERT INTO cafe_menu_sales (sale_date, menu_id, qty, amount) VALUES ($1,$2,$3,$4)`,
        [dateStr, menuIds[name], qty, amount]
      );
      menuRows++;
    }
    totalRevenue += revenue;

    await client.query(
      `INSERT INTO cafe_daily_sales (sale_date, weekday, visitors, order_count, revenue, weather, is_closed)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
      [dateStr, weekday, visitors, orderCount, revenue, weather]
    );

    const takeout = Math.round(visitors * jitter(isWeekend ? 0.28 : 0.42, 0.12));
    const peak = isWeekend ? pick(['14-16시', '15-17시', '13-15시']) : pick(['08-09시', '12-13시', '15-17시', '19-20시']);
    await client.query(
      `INSERT INTO cafe_visitors (visit_date, weekday, visitors, dine_in_count, takeout_count, peak_hour)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [dateStr, weekday, visitors, visitors - takeout, takeout, peak]
    );
  }
  console.log(`✅ 일별 매출 ${DAYS}일 / 메뉴별 판매 ${menuRows}행 / 방문객 ${DAYS}일`);

  // 4) 리뷰 — 90일 기간에 흩뿌리기
  for (let i = 0; i < REVIEWS.length; i++) {
    const [source, author, rating, menu, content] = REVIEWS[i];
    const offset = Math.floor((i / REVIEWS.length) * DAYS + rand() * 3);
    const rd = fmt(new Date(START.getTime() + Math.min(offset, DAYS - 1) * 86400000));
    await client.query(
      `INSERT INTO cafe_reviews (review_date, source, author, rating, menu, content)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [rd, source, author, rating, menu, content]
    );
  }
  console.log(`✅ 리뷰 ${REVIEWS.length}건`);

  // 5) 발주 — 매주 화/금 정기 발주 (품목별 주기 다름)
  let poCount = 0;
  const CYCLE = { // 발주 주기(일)
    '원두': 14, '유제품': 3, '견과': 14, '베이커리': 3, '부재료': 21, '부자재': 30,
  };
  for (const [item, category, unit, , safety, cost] of INVENTORY) {
    const cycle = CYCLE[category];
    const orderQty = Number(safety) * (category === '부자재' ? 4 : 2.5);
    for (let d = 3; d < DAYS; d += cycle) {
      const od = new Date(START.getTime() + d * 86400000);
      const qty = Math.round(orderQty * jitter(1, 0.2) * 100) / 100;
      const amount = Math.round(qty * cost);
      const daysAgo = DAYS - d;
      const status = daysAgo > 3 ? '입고완료' : daysAgo > 1 ? '배송중' : '발주요청';
      const expected = fmt(new Date(od.getTime() + 2 * 86400000));
      await client.query(
        `INSERT INTO cafe_purchase_orders (order_date, item_id, qty, unit_cost, amount, status, expected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [fmt(od), invIds[item], qty, cost, amount, status, expected]
      );
      poCount++;
    }
    // 최근 발주일 반영
    await client.query(
      `UPDATE cafe_inventory SET last_ordered_at =
         (SELECT MAX(order_date) FROM cafe_purchase_orders WHERE item_id = cafe_inventory.id)
       WHERE item_name = $1`, [item]
    );
  }
  console.log(`✅ 발주 ${poCount}건`);

  console.log('\n📊 요약');
  console.log(`  기간: ${fmt(START)} ~ ${fmt(new Date(START.getTime() + (DAYS - 1) * 86400000))} (${DAYS}일)`);
  console.log(`  총매출: ${totalRevenue.toLocaleString()}원 (일평균 ${Math.round(totalRevenue / DAYS).toLocaleString()}원)`);

  await client.end();
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
