#!/usr/bin/env python3
"""
fal.ai(flux/schnell)로 음식 썸네일 이미지를 생성해 파일로 저장한다.

사용법:
    py gen_thumbnail.py --prompt "요리 영어 설명" --out "저장경로.jpg"

- API 키는 환경변수 FAL_KEY 또는 스크립트 폴더의 fal_key.txt 에서 읽는다.
- 표준 라이브러리(urllib)만 사용하므로 pip 설치가 필요 없다.
- 성공하면 마지막 줄에 저장된 파일의 절대경로를 출력한다.
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

FAL_ENDPOINT = "https://fal.run/fal-ai/flux/schnell"


def load_key():
    key = os.environ.get("FAL_KEY", "").strip()
    if key:
        return key
    key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fal_key.txt")
    if os.path.exists(key_file):
        with open(key_file, "r", encoding="utf-8") as f:
            return f.read().strip()
    sys.exit("FAL_KEY 환경변수도, fal_key.txt 파일도 찾을 수 없습니다.")


def generate(prompt, image_size):
    body = json.dumps({
        "prompt": prompt,
        "image_size": image_size,
        "num_images": 1,
    }).encode("utf-8")
    req = urllib.request.Request(
        FAL_ENDPOINT,
        data=body,
        headers={
            "Authorization": "Key " + load_key(),
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        sys.exit(f"fal.ai 호출 실패 (HTTP {e.code}): {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"네트워크 오류: {e.reason}")
    images = data.get("images") or []
    if not images:
        sys.exit(f"이미지가 반환되지 않았습니다: {data}")
    return images[0]["url"]


def download(url, out_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as resp:
        img = resp.read()
    with open(out_path, "wb") as f:
        f.write(img)
    return os.path.abspath(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True, help="음식 이미지 프롬프트(영어 권장)")
    ap.add_argument("--out", required=True, help="저장할 이미지 경로 (.jpg)")
    ap.add_argument("--size", default="landscape_4_3",
                    help="이미지 비율 (기본 landscape_4_3)")
    args = ap.parse_args()

    url = generate(args.prompt, args.size)
    saved = download(url, args.out)
    print(saved)


if __name__ == "__main__":
    main()
