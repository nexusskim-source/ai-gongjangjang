# -*- coding: utf-8 -*-
"""
download_files.py - 금융 규제/가이드라인 자료 다운로더 (표준 라이브러리만 사용)

실행:
    py -3 download_files.py <manifest.json>

manifest.json 형식:
{
  "folder": "C:\\수경_에이전트파일다운\\제목_20260705",
  "items": [
    {"name": "전자금융거래법", "url": "https://www.law.go.kr/.../file.pdf"},
    {"name": "금융분야 클라우드 이용 가이드", "url": "https://.../guide.pdf"}
  ]
}

동작:
  - folder 자동 생성 (한글 경로 OK)
  - 브라우저 User-Agent, 30초 타임아웃, 최대 3회 재시도, 리다이렉트 처리
  - Content-Disposition / URL / Content-Type 순으로 파일명·확장자 자동 인식 (한글 파일명 지원)
  - 정부·공공기관 사이트의 SSL 인증서 오류 시 검증 완화 후 재시도
  - 결과 요약을 stdout 및 <folder>/_다운로드결과.json 에 기록

pip 설치가 필요 없다. 실패한 항목은 결과에 사유와 함께 남기므로, 실패분은 출처 링크로 안내하면 된다.
"""
import sys
import os
import re
import json
import ssl
import time
import mimetypes
import urllib.request
import urllib.error
import urllib.parse
from urllib.parse import urlparse, unquote

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

CT_EXT = {
    "application/pdf": ".pdf",
    "application/haansofthwp": ".hwp",
    "application/x-hwp": ".hwp",
    "application/vnd.hancom.hwp": ".hwp",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/zip": ".zip",
    "text/html": ".html",
    "text/plain": ".txt",
}

ILLEGAL = re.compile(r'[\\/:*?"<>|\r\n\t]')

# 서버 스크립트 확장자는 실제 파일형식이 아니므로 무시하고 Content-Type으로 판별
NONFILE_EXT = {".do", ".jsp", ".php", ".asp", ".aspx", ".action", ".nhn", ".cgi", ".htm"}


def sanitize(name, maxlen=120):
    name = ILLEGAL.sub("_", name).strip().strip(".")
    name = re.sub(r"_+", "_", name)
    return name[:maxlen] if name else "file"


def parse_cd_filename(cd):
    """Content-Disposition 에서 파일명 추출 (RFC5987 및 일반 케이스)."""
    if not cd:
        return None
    m = re.search(r"filename\*=(?:UTF-8|utf-8)''([^;]+)", cd)
    if m:
        try:
            return unquote(m.group(1))
        except Exception:
            pass
    m = re.search(r'filename="?([^";]+)"?', cd)
    if m:
        raw = m.group(1).strip()
        # 일부 국내 사이트는 EUC-KR/latin-1 로 인코딩된 헤더를 보냄
        for enc in ("utf-8", "euc-kr", "cp949"):
            try:
                return raw.encode("latin-1").decode(enc)
            except Exception:
                continue
        return raw
    return None


def pick_extension(url, cd_name, content_type):
    for cand in (cd_name, urlparse(url).path):
        if cand:
            ext = os.path.splitext(unquote(cand))[1].lower()
            if (ext and len(ext) <= 6 and re.match(r"^\.[a-z0-9]+$", ext)
                    and ext not in NONFILE_EXT):
                return ext
    if content_type:
        ct = content_type.split(";")[0].strip().lower()
        if ct in CT_EXT:
            return CT_EXT[ct]
        guess = mimetypes.guess_extension(ct)
        if guess:
            return guess
    return ".bin"


def fetch(url, insecure=False, method="GET", data=None, referer=None):
    ctx = ssl._create_unverified_context() if insecure else None
    body = None
    if method.upper() == "POST" and data:
        body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method=method.upper(),
        headers={"User-Agent": UA, "Referer": referer or url})
    return urllib.request.urlopen(req, timeout=30, context=ctx)


def download_one(item, folder):
    name = item.get("name") or "file"
    url = item.get("url", "").strip()
    method = item.get("method", "GET")
    data = item.get("data")        # POST 폼 데이터(dict). 정부 게시판 JS 다운로드 대응
    referer = item.get("referer")  # 필요 시 상세페이지 URL
    result = {"name": name, "url": url}
    if not url.lower().startswith(("http://", "https://")):
        result.update(ok=False, error="유효한 http(s) URL 아님")
        return result

    last_err = None
    for attempt in range(3):
        for insecure in (False, True):
            try:
                with fetch(url, insecure=insecure, method=method, data=data, referer=referer) as resp:
                    cd = resp.headers.get("Content-Disposition")
                    ct = resp.headers.get("Content-Type")
                    cd_name = parse_cd_filename(cd)
                    ext = pick_extension(url, cd_name, ct)
                    base = sanitize(name)
                    path = os.path.join(folder, base + ext)
                    n = 1
                    while os.path.exists(path):
                        path = os.path.join(folder, f"{base}({n}){ext}")
                        n += 1
                    data = resp.read()
                    if not data:
                        raise IOError("빈 응답(0바이트)")
                    with open(path, "wb") as f:
                        f.write(data)
                    result.update(
                        ok=True,
                        saved_as=os.path.basename(path),
                        path=path,
                        bytes=len(data),
                        content_type=(ct or "").split(";")[0].strip(),
                        ssl_relaxed=insecure,
                    )
                    return result
            except (urllib.error.HTTPError, urllib.error.URLError, ssl.SSLError,
                    IOError, TimeoutError) as e:
                last_err = f"{type(e).__name__}: {e}"
                # SSL 문제면 insecure 재시도가 의미 있으니 계속, 그 외에는 다음 attempt로
                if not isinstance(e, ssl.SSLError):
                    break
        time.sleep(1.2 * (attempt + 1))
    result.update(ok=False, error=last_err or "알 수 없는 오류")
    return result


def main():
    # Windows 콘솔 기본 코드페이지(cp949)에서 한글이 깨지지 않도록 UTF-8 출력 고정
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if len(sys.argv) < 2:
        print("사용법: py -3 download_files.py <manifest.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        manifest = json.load(f)

    folder = manifest["folder"]
    items = manifest.get("items", [])
    os.makedirs(folder, exist_ok=True)

    results = [download_one(it, folder) for it in items]
    ok = [r for r in results if r.get("ok")]
    fail = [r for r in results if not r.get("ok")]

    summary = {"folder": folder, "total": len(results),
               "succeeded": len(ok), "failed": len(fail), "results": results}
    with open(os.path.join(folder, "_다운로드결과.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"저장 폴더: {folder}")
    print(f"성공 {len(ok)} / 실패 {len(fail)} (총 {len(results)})")
    for r in ok:
        print(f"  [OK]   {r['saved_as']}  ({r['bytes']:,} bytes)")
    for r in fail:
        print(f"  [FAIL] {r['name']}  <-  {r.get('error')}")
        print(f"         출처: {r['url']}")


if __name__ == "__main__":
    main()
