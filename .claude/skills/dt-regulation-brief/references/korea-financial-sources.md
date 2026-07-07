# 국내 금융 규제·자료 출처 참고

기사에서 관련 자료를 식별하고 **직접 다운로드 링크**를 찾을 때 쓰는 참고 자료다.
목표는 "이 기사와 관련해 DT본부장이 실제로 열어봐야 할 원문"을 모으는 것이다.

## 1. 자료 유형과 1차 출처

| 유형 | 대표 출처 | 다운로드 형태 |
|---|---|---|
| 법령(법·시행령·시행규칙) | 국가법령정보센터 `www.law.go.kr` | HTML 본문 / PDF |
| 행정규칙·감독규정(예: 전자금융감독규정) | 국가법령정보센터, 금융위 `www.fsc.go.kr` | HTML / PDF / HWP |
| 보도자료·정책방향 | 금융위원회 `www.fsc.go.kr`, 금융감독원 `www.fss.or.kr` | PDF/HWP 첨부 |
| 가이드라인·모범규준 | 금융보안원 `www.fsec.or.kr`, 금융위, 금감원 | PDF/HWP 첨부 |
| 실무 매뉴얼·해설서 | 각 협회(은행연합회 `www.kfb.or.kr`, 금투협 `www.kofia.or.kr`, 여신협회, 생·손보협회) | PDF |
| 국제 기준 | BIS/BCBS, FSB, FATF (영문) | PDF |

## 2. 링크를 찾는 방법

직접 파일 URL을 얻는 것이 핵심이다. 순서대로 시도한다.

1. **WebSearch**로 `"<자료명>" 파일다운 pdf` 또는 `<자료명> site:fsc.go.kr`, `... site:fsec.or.kr`, `... site:law.go.kr` 검색.
2. 후보 페이지를 **WebFetch**로 열어 `.pdf` / `.hwp` / `download` / `fileDown` 이 포함된 실제 첨부 링크를 추출.
3. 국가법령정보센터 법령은 검색 결과의 법령 상세 페이지 URL을 그대로 `download_files.py`에 넘겨도 된다(HTML로 저장됨). PDF가 필요하면 상세 페이지의 인쇄/PDF 링크를 찾는다.
4. 첨부가 게시판 뒤에 숨어 직접 링크를 못 찾으면, 그 자료는 다운로드하지 말고 **출처 링크만 매니페스트 메모**에 남긴다(무리한 추정 URL 금지).

> 팁: 금융위·금감원 보도자료는 본문 PDF와 "별첨" PDF(가이드라인 원문)가 따로 있다. 별첨이 진짜 알맹이인 경우가 많으니 함께 확보한다.

### 사이트별 다운로드 요령 (검증됨)
- **금융위 fsc.go.kr**: 첨부는 `/comm/getFile?srvcId=BBSTY1&upperNo=<글번호>&fileTy=ATTACH&fileNo=<n>` GET 직링크. 보도자료 페이지를 WebFetch하면 fileNo 목록이 나온다.
- **금융보안원 fsec.or.kr**: 게시판 목록/상세는 `javascript:void(0)`라 직링크가 안 보인다. 그러나 상세 페이지의 첨부 `<a>`에 `fileno="…"` `filepage="board"` 속성이 있고, `downloadFile()`이 **POST `/file/downloadFile`** (form: `fileNo`, `filePage`)로 받는다. → `download_files.py`의 POST 지원으로 처리(아래).
  - 상세 페이지 bbsNo를 모르면 Playwright로 목록(`/bbs/222` 등)에서 글을 클릭해 상세로 이동한 뒤, 첨부 `<a>`의 `fileno` 속성을 읽는다.
- **KDI eiec.kdi.re.kr**: 금감원 등 정책원문을 미러링. `/policy/callDownload.do?num=<id>&filenum=1` GET 직링크로 받아진다(금감원 사이트 직링크가 어려울 때 우회로).

### download_files.py 의 POST 다운로드
게시판 JS 폼 다운로드는 manifest item에 `method`/`data`/`referer`를 넣으면 된다:
```json
{"name":"금융보안원 AI 보안 안내서","url":"https://www.fsec.or.kr/file/downloadFile",
 "method":"POST","data":{"fileNo":"13671","filePage":"board"},
 "referer":"https://www.fsec.or.kr/bbs/detail?menuNo=222&bbsNo=11977"}
```

## 3. 금융 DT에서 자주 엮이는 법령·규정 (매핑 힌트)

기사 주제에서 아래를 연상해 관련 자료를 폭넓게 식별한다.

- **전자금융 / 보안**: 전자금융거래법, 전자금융감독규정, 금융보안원 각종 가이드(정보보호, 침해대응), 망분리 규제 완화 논의
- **데이터 / 마이데이터**: 신용정보법(신용정보의 이용 및 보호에 관한 법률), 개인정보보호법, 금융분야 마이데이터 서비스 가이드라인, 가명정보 활용 안내서
- **클라우드**: 금융분야 클라우드컴퓨팅서비스 이용 가이드, 전자금융감독규정(제14조의2 등), 금융보안원 클라우드 보안 가이드
- **AI**: 금융분야 AI 가이드라인, AI 개발·활용 안내서, 설명가능성·공정성 관련 금융위 정책자료, (해외) EU AI Act 동향
- **디지털자산 / 가상자산**: 가상자산이용자보호법, 특정금융정보법(특금법), 트래블룰
- **오픈뱅킹 / 지급결제**: 전자금융거래법 개정(지급지시전달업 등), 오픈뱅킹 관련 금융결제원 자료
- **소비자보호 / 내부통제**: 금융소비자보호법, 금융회사 지배구조법, 내부통제 관련 감독규정

## 4. 파일명 규칙

`download_files.py`가 `name` 필드로 파일명을 만든다. 사람이 폴더만 열어도 알 수 있게 자료명을 명확히 준다.
예: `"전자금융감독규정"`, `"금융분야 클라우드 이용 가이드(2022개정)"`, `"금융위 보도자료_망분리 개선"`.
