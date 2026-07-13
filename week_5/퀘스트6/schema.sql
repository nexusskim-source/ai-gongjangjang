-- ☕ Day On (데이온) 카페 운영 DB 스키마
-- week_5/퀘스트6 — my_cafe.md 기획서 기반

DROP TABLE IF EXISTS cafe_purchase_orders CASCADE;
DROP TABLE IF EXISTS cafe_menu_sales CASCADE;
DROP TABLE IF EXISTS cafe_reviews CASCADE;
DROP TABLE IF EXISTS cafe_visitors CASCADE;
DROP TABLE IF EXISTS cafe_daily_sales CASCADE;
DROP TABLE IF EXISTS cafe_inventory CASCADE;
DROP TABLE IF EXISTS cafe_menus CASCADE;

-- 1) 메뉴 마스터
CREATE TABLE cafe_menus (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  category     TEXT NOT NULL,          -- 커피 / 논커피 / 디저트 / 사이드 / 세트
  price        INTEGER NOT NULL,       -- 판매가(원)
  cost         INTEGER NOT NULL,       -- 원가(원)
  is_signature BOOLEAN NOT NULL DEFAULT FALSE
);

-- 2) 일별 매출
CREATE TABLE cafe_daily_sales (
  id          SERIAL PRIMARY KEY,
  sale_date   DATE NOT NULL UNIQUE,
  weekday     TEXT NOT NULL,           -- 월~일
  visitors    INTEGER NOT NULL,        -- 손님 수
  order_count INTEGER NOT NULL,        -- 주문 건수
  revenue     INTEGER NOT NULL,        -- 매출(원) = 메뉴별 판매 합계
  weather     TEXT,                    -- 맑음/흐림/비/폭염
  is_closed   BOOLEAN NOT NULL DEFAULT FALSE  -- 정기휴무
);

-- 3) 메뉴별 판매량 (일자 × 메뉴)
CREATE TABLE cafe_menu_sales (
  id        SERIAL PRIMARY KEY,
  sale_date DATE NOT NULL,
  menu_id   INTEGER NOT NULL REFERENCES cafe_menus(id) ON DELETE CASCADE,
  qty       INTEGER NOT NULL,
  amount    INTEGER NOT NULL,          -- qty * price
  UNIQUE (sale_date, menu_id)
);
CREATE INDEX idx_menu_sales_date ON cafe_menu_sales(sale_date);
CREATE INDEX idx_menu_sales_menu ON cafe_menu_sales(menu_id);

-- 4) 손님 리뷰
CREATE TABLE cafe_reviews (
  id          SERIAL PRIMARY KEY,
  review_date DATE NOT NULL,
  source      TEXT NOT NULL,           -- 네이버 / 카카오맵 / 구글 / 인스타그램
  author      TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  menu        TEXT,                    -- 언급된 주요 메뉴
  content     TEXT NOT NULL
);
CREATE INDEX idx_reviews_date ON cafe_reviews(review_date);

-- 5) 재고
CREATE TABLE cafe_inventory (
  id             SERIAL PRIMARY KEY,
  item_name      TEXT NOT NULL UNIQUE,
  category       TEXT NOT NULL,        -- 원두/유제품/베이커리/견과/부자재 등
  unit           TEXT NOT NULL,        -- kg, L, 개, 병 ...
  current_stock  NUMERIC(10,2) NOT NULL,
  safety_stock   NUMERIC(10,2) NOT NULL,  -- 안전재고(이하면 발주 필요)
  unit_cost      INTEGER NOT NULL,
  supplier       TEXT NOT NULL,
  last_ordered_at DATE
);

-- 6) 발주
CREATE TABLE cafe_purchase_orders (
  id          SERIAL PRIMARY KEY,
  order_date  DATE NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES cafe_inventory(id) ON DELETE CASCADE,
  qty         NUMERIC(10,2) NOT NULL,
  unit_cost   INTEGER NOT NULL,
  amount      INTEGER NOT NULL,        -- qty * unit_cost
  status      TEXT NOT NULL,           -- 입고완료 / 배송중 / 발주요청
  expected_at DATE
);
CREATE INDEX idx_po_date ON cafe_purchase_orders(order_date);

-- 7) 요일별 손님 수 (일자별 방문 상세 → 요일 집계용)
CREATE TABLE cafe_visitors (
  id            SERIAL PRIMARY KEY,
  visit_date    DATE NOT NULL UNIQUE,
  weekday       TEXT NOT NULL,
  visitors      INTEGER NOT NULL,
  dine_in_count INTEGER NOT NULL,      -- 매장
  takeout_count INTEGER NOT NULL,      -- 테이크아웃
  peak_hour     TEXT                   -- 피크 시간대
);
CREATE INDEX idx_visitors_weekday ON cafe_visitors(weekday);
