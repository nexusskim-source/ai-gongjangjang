#!/usr/bin/env python3
"""
레시피 마크다운(recipe.md)과 썸네일 이미지를 합쳐 자기완결형 HTML 한 파일로 만든다.
이미지는 base64로 문서 안에 박아 넣으므로 HTML 파일 하나만 있으면 어디서든 그대로 보인다.

사용법:
    py build_recipe_html.py --md "recipe.md" --img "thumb.jpg" --out "recipe.html"

- 마크다운의 맨 위 이미지(![...](...))는 base64 데이터 URI로 치환한다.
- 표준 라이브러리만 사용한다(pip 불필요).
"""
import argparse
import base64
import html
import mimetypes
import os
import re
import sys


def md_to_html(md, data_uri):
    lines = md.splitlines()
    out = []
    in_ul = in_ol = False

    def close_lists():
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    def inline(t):
        t = html.escape(t)
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", t)
        t = re.sub(r"`(.+?)`", r"<code>\1</code>", t)
        return t

    for raw in lines:
        line = raw.rstrip()
        # 이미지 (맨 위 썸네일 등)
        m = re.match(r"!\[(.*?)\]\((.*?)\)", line.strip())
        if m:
            close_lists()
            alt = html.escape(m.group(1))
            out.append(f'<img class="thumb" src="{data_uri}" alt="{alt}">')
            continue
        if not line.strip():
            close_lists()
            continue
        if line.startswith("### "):
            close_lists(); out.append(f"<h3>{inline(line[4:])}</h3>"); continue
        if line.startswith("## "):
            close_lists(); out.append(f"<h2>{inline(line[3:])}</h2>"); continue
        if line.startswith("# "):
            close_lists(); out.append(f"<h1>{inline(line[2:])}</h1>"); continue
        if line.strip() in ("---", "***", "___"):
            close_lists(); out.append("<hr>"); continue
        if line.startswith("> "):
            close_lists(); out.append(f"<blockquote>{inline(line[2:])}</blockquote>"); continue
        m = re.match(r"\s*\d+\.\s+(.*)", line)
        if m:
            if in_ul:
                out.append("</ul>"); in_ul = False
            if not in_ol:
                out.append("<ol>"); in_ol = True
            out.append(f"<li>{inline(m.group(1))}</li>"); continue
        m = re.match(r"\s*[-*]\s+(.*)", line)
        if m:
            if in_ol:
                out.append("</ol>"); in_ol = False
            if not in_ul:
                out.append("<ul>"); in_ul = True
            out.append(f"<li>{inline(m.group(1))}</li>"); continue
        close_lists()
        out.append(f"<p>{inline(line)}</p>")
    close_lists()
    return "\n".join(out)


TEMPLATE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin:0; background:#f3f4f6; font-family:'Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;
         color:#1f2937; line-height:1.7; }}
  .card {{ max-width:680px; margin:24px auto; background:#fff; border-radius:18px; overflow:hidden;
          box-shadow:0 10px 30px rgba(0,0,0,.12); }}
  img.thumb {{ display:block; width:100%; height:auto; }}
  .body {{ padding:24px 28px 32px; }}
  h1 {{ font-size:1.8rem; margin:.2em 0 .3em; }}
  h2 {{ font-size:1.2rem; margin:1.4em 0 .5em; border-bottom:2px solid #f1f5f9; padding-bottom:.2em; }}
  blockquote {{ margin:0 0 1em; padding:.6em 1em; background:#fff7ed; border-left:4px solid #fb923c;
               border-radius:8px; color:#9a3412; }}
  ul,ol {{ padding-left:1.3em; }}
  li {{ margin:.25em 0; }}
  hr {{ border:none; border-top:1px solid #e5e7eb; margin:1.5em 0; }}
  code {{ background:#f1f5f9; padding:.1em .35em; border-radius:5px; font-size:.9em; }}
  p:last-child {{ color:#9ca3af; font-size:.85rem; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background:#111827; color:#e5e7eb; }}
    .card {{ background:#1f2937; box-shadow:0 10px 30px rgba(0,0,0,.5); }}
    h2 {{ border-color:#374151; }}
    blockquote {{ background:#3a2a12; color:#fdba74; }}
    code {{ background:#374151; }}
    hr {{ border-color:#374151; }}
  }}
</style></head>
<body><div class="card">{img_top}<div class="body">{content}</div></div></body></html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", required=True)
    ap.add_argument("--img", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="레시피")
    args = ap.parse_args()

    if not os.path.exists(args.md):
        sys.exit(f"마크다운 파일 없음: {args.md}")
    if not os.path.exists(args.img):
        sys.exit(f"이미지 파일 없음: {args.img}")

    with open(args.md, "r", encoding="utf-8") as f:
        md = f.read()
    mime = mimetypes.guess_type(args.img)[0] or "image/jpeg"
    with open(args.img, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    data_uri = f"data:{mime};base64,{b64}"

    # 첫 번째 이미지(썸네일)는 카드 상단에 크게, 본문에서는 제거
    img_top = ""
    m = re.search(r"!\[(.*?)\]\((.*?)\)", md)
    if m:
        img_top = f'<img class="thumb" src="{data_uri}" alt="{html.escape(m.group(1))}">'
        md = md[:m.start()] + md[m.end():]

    # 제목 추출(첫 # 헤딩)
    title = args.title
    tm = re.search(r"^#\s+(.*)$", md, re.MULTILINE)
    if tm:
        title = re.sub(r"[^\w\s가-힣].*$", "", tm.group(1)).strip() or args.title

    content = md_to_html(md, data_uri)
    out_html = TEMPLATE.format(title=html.escape(title), img_top=img_top, content=content)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(out_html)
    print(os.path.abspath(args.out))


if __name__ == "__main__":
    main()
