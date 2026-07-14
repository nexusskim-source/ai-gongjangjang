# 퀘스트5 — 사장님 전용 대시보드 (디저트 쇼핑몰 + 카페 운영 데이터 + AI 브리핑)

기존 디저트 쇼핑몰(https://dessert-shop-rouge.vercel.app)에 **사장님(admin)만 들어갈 수 있는 대시보드**를 추가했다.
쇼핑몰 화면/기능은 그대로 두고, admin 로그인 시에만 상단바에 👑 **대시보드** 버튼이 생긴다.

## 접속

| 항목 | 값 |
|---|---|
| 배포 URL | https://dessert-shop-rouge.vercel.app |
| 사장님 아이디 | `admin` |
| 비밀번호 | `450909` |

로그인하면 대시보드로 바로 이동한다. 일반 회원은 버튼도 안 보이고, API 를 직접 찔러도 403 이다.

## 대시보드 구성 (바탕화면 `네이버.png` 예시 기반)

- **KPI 4칸** — 최근 영업일 매출(전일 대비 증감), 손님 수, 객단가, 리뷰 평점
- **오늘 할 일** — 체크/추가/삭제. Supabase `shop_admin_todos` 에 저장
- **AI 브리핑** — "오늘의 카페 브리핑" (아래 설명)
- **이번 주 매출** — 월~일 일별 막대그래프 + 지난주 대비 증감
- **인기 메뉴 TOP3** — 최근 7일 판매량 기준
- **발주 필요 재고** — 안전재고 이하 품목
- **최근 리뷰** — 최근 3건 + 30일 평균 별점

## 데이터

대시보드 숫자는 전부 **week_5/퀘스트6 에서 적재한 카페 운영 DB(`cafe_*` 7개 테이블, 90일치)** 에서 집계한다.
기준일은 데이터가 있는 가장 최근 영업일(2026-07-12)이다.

| 위젯 | 출처 테이블 |
|---|---|
| KPI, 이번 주 매출 | `cafe_daily_sales` |
| 인기 메뉴 TOP3 | `cafe_menu_sales` + `cafe_menus` |
| 리뷰 | `cafe_reviews` |
| 발주 필요 재고 | `cafe_inventory` |
| 오늘 할 일 | `shop_admin_todos` (이 앱 전용, 신규) |

## AI 브리핑이 종합하는 것

`POST /api/admin/briefing` 이 아래를 한데 모아 **gpt-4o-mini** 에 넘기고, 사장님이 아침에 30초 안에 읽을 3~4문장을 받는다.

1. 최근 영업일 매출·손님·객단가와 직전 영업일 대비 증감
2. 이번 주 매출 합계와 지난주 대비 증감, 요일별 매출
3. 최근 7일 인기 메뉴 판매량
4. 최근 30일 리뷰 평점과 최근 리뷰 원문
5. 안전재고 이하 발주 필요 품목
6. 날씨별 하루 평균 매출 (비 오는 날 매출이 얼마나 빠지는지)
7. **오늘 연희동 실시간 날씨 예보** (Open-Meteo, 키 불필요)
8. 사장님의 할 일 목록

마지막 문장은 항상 "오늘 당장 할 액션 1가지"로 끝난다. OpenAI 키가 없거나 호출이 실패하면 규칙 기반 브리핑으로 자동 대체된다.

## 파일

- `admin.js` — 권한 확인 + 카페 DB 집계 + 할 일 CRUD + AI 브리핑 (로컬/배포 공용)
- `api/admin/dashboard.js` · `api/admin/todos.js` · `api/admin/briefing.js` — Vercel 서버리스 함수
- `server.js` — 로컬용 `/api/admin/*` 라우팅
- `index.html` — `AdminDashboardView` 및 위젯 컴포넌트

## 권한 통제

토큰의 username 만 믿지 않는다. 서버가 매 요청마다 `shop_users` 를 다시 조회해 `username === 'admin'` 인지 확인한다.
(비로그인 401 / 일반회원 403)

## 로컬 실행

```bash
npm install
node server.js        # http://localhost:3000
```

`.env` 에 `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY` 필요. (`.env.example` 참고)
