# 잠원마켓 🥕 — 당근마켓 클론 (week_7 / 퀘스트6)

우리 동네 **잠원동** 중고 직거래 웹앱.
**Supabase Auth + DB + Storage + RLS + Polling 채팅**, React 단일 파일(CDN).

## 기능
- **회원가입/로그인** (이메일) · 동네 = 잠원동 자동 설정
- **상품 등록**: 이미지 최대 3장(Storage 업로드) + 제목/가격/설명/카테고리, 본인만 수정·삭제(RLS)
- **목록/검색**: 최신순 + 카테고리 필터 + 키워드 검색(제목·설명)
- **상세**: 이미지 슬라이드 · 작성자 · 관심(❤️) 버튼 · 채팅하기
- **채팅**: 상품별 1:1, 2.5초 Polling 실시간
- **마이페이지**: 내 판매내역 / 관심목록 / 채팅

## 구조
- `index.html` — 앱 전체 (React + Tailwind + supabase-js, 모두 CDN)
- `schema.sql` — 테이블·RLS·Storage 정책
- `setup-db.js` — schema.sql 을 Supabase에 적용

## 설정
1. `index.html` 하단 `window.APP_CONFIG.SUPABASE_ANON_KEY` 에
   Supabase → Project Settings → API → **anon public** 키 입력.
2. Supabase → Authentication → Providers → Email 에서
   데모 편의를 위해 **"Confirm email" 끄기**(가입 즉시 로그인).
3. DB 셋업(최초 1회): `node setup-db.js`

## 배포 (Vercel)
정적 배포. 폴더에서 `vercel --prod` 또는 GitHub 연동.
빌드 명령 없음(Output: 현재 폴더).
