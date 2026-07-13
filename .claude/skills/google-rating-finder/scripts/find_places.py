#!/usr/bin/env python3
"""Google Places API (New) 로 장소를 검색해 평점순으로 정리한다.

리뷰수 하한으로 신뢰도를 확보한 뒤 평점 내림차순(동점이면 리뷰수)으로 정렬한다.
표준 라이브러리만 사용하므로 pip 설치가 필요 없다.

사용 예:
  python find_places.py "강남역 브런치 카페"
  python find_places.py "홍대 감성 카페" --min-reviews 50 --top 8 --open-now
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# 윈도우 콘솔(cp949)에서도 한글·이모지(⭐🟢₩)가 깨지지 않도록 UTF-8로 강제한다.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

API_URL = "https://places.googleapis.com/v1/places:searchText"

# 스크립트 기준 상위(스킬 루트)에서 키 파일을 찾는다.
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_FILE = os.path.join(SKILL_DIR, "google_places_key.txt")

PRICE_LABELS = {
    "PRICE_LEVEL_FREE": "무료",
    "PRICE_LEVEL_INEXPENSIVE": "₩",
    "PRICE_LEVEL_MODERATE": "₩₩",
    "PRICE_LEVEL_EXPENSIVE": "₩₩₩",
    "PRICE_LEVEL_VERY_EXPENSIVE": "₩₩₩₩",
}

FIELD_MASK = ",".join([
    "places.displayName",
    "places.rating",
    "places.userRatingCount",
    "places.formattedAddress",
    "places.googleMapsUri",
    "places.priceLevel",
    "places.currentOpeningHours.openNow",
    "places.primaryTypeDisplayName",
])


def load_api_key():
    if not os.path.exists(KEY_FILE):
        sys.exit(
            f"[키 없음] API 키 파일이 없습니다: {KEY_FILE}\n"
            "SKILL.md의 '① API 키 발급' 안내를 따라 키를 만든 뒤,\n"
            "위 경로에 키 값만 한 줄로 저장하세요."
        )
    with open(KEY_FILE, "r", encoding="utf-8") as f:
        key = f.read().strip()
    if not key:
        sys.exit(f"[키 비어있음] {KEY_FILE} 파일에 키 값이 없습니다.")
    return key


def search(query, api_key, open_now):
    body = {
        "textQuery": query,
        "languageCode": "ko",
        "regionCode": "KR",
        "pageSize": 20,
    }
    if open_now:
        body["openNow"] = True
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(API_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-Api-Key", api_key)
    req.add_header("X-Goog-FieldMask", FIELD_MASK)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(
            f"[API 오류 {e.code}] {detail}\n"
            "→ 키가 유효한지, Places API(New)가 활성화됐는지, 결제(무료 크레딧) 설정이 됐는지 확인하세요."
        )
    except urllib.error.URLError as e:
        sys.exit(f"[네트워크 오류] {e.reason}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="검색어 (예: '강남역 브런치 카페')")
    ap.add_argument("--min-reviews", type=int, default=30, help="리뷰수 하한 (기본 30)")
    ap.add_argument("--top", type=int, default=10, help="상위 몇 곳 (기본 10)")
    ap.add_argument("--open-now", action="store_true", help="지금 영업중만")
    args = ap.parse_args()

    api_key = load_api_key()
    result = search(args.query, api_key, args.open_now)
    places = result.get("places", [])

    if not places:
        print(f"'{args.query}' 검색 결과가 없습니다. 검색어를 바꿔보세요.")
        return

    # 리뷰수 하한 필터
    filtered = [p for p in places if p.get("userRatingCount", 0) >= args.min_reviews]
    dropped = len(places) - len(filtered)

    # 하한 때문에 다 걸러지면, 사용자가 판단하도록 원본을 보여준다.
    used_fallback = False
    if not filtered:
        filtered = places
        used_fallback = True

    # 평점 내림차순, 동점이면 리뷰수 내림차순
    filtered.sort(
        key=lambda p: (p.get("rating", 0), p.get("userRatingCount", 0)),
        reverse=True,
    )
    top = filtered[: args.top]

    print(f"# 🔍 '{args.query}' — 구글 평점순 (리뷰 {args.min_reviews}개 이상)\n")
    if used_fallback:
        print(f"> ⚠️ 리뷰 {args.min_reviews}개 이상인 곳이 없어, 하한 없이 전체를 평점순으로 보여줍니다.\n")

    print("| 순위 | 이름 | 평점 | 리뷰수 | 종류 | 가격 | 영업 | 주소 |")
    print("|------|------|------|--------|------|------|------|------|")
    for i, p in enumerate(top, 1):
        name = p.get("displayName", {}).get("text", "-")
        rating = p.get("rating", "-")
        reviews = p.get("userRatingCount", 0)
        kind = p.get("primaryTypeDisplayName", {}).get("text", "-")
        price = PRICE_LABELS.get(p.get("priceLevel", ""), "-")
        open_now = p.get("currentOpeningHours", {}).get("openNow")
        open_str = "🟢영업중" if open_now is True else ("🔴영업종료" if open_now is False else "-")
        addr = p.get("formattedAddress", "-")
        uri = p.get("googleMapsUri", "")
        name_cell = f"[{name}]({uri})" if uri else name
        print(f"| {i} | {name_cell} | ⭐{rating} | {reviews} | {kind} | {price} | {open_str} | {addr} |")

    if dropped and not used_fallback:
        print(f"\n_리뷰 {args.min_reviews}개 미만 {dropped}곳은 신뢰도 필터로 제외됨._")


if __name__ == "__main__":
    main()
