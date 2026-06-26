// ============================================================
// 나에 대한 Q&A 서버 (김수경 About-Me Q&A)
//
// 같은 폴더의 about_me.md 내용을 근거로만 사용자의 질문에 답하는
// 백엔드 서버입니다. OpenAI Chat Completions API를 사용합니다.
//
// 실행법:
//   1) 같은 폴더에 .env 파일을 두고 OPENAI_API_KEY=sk-... 를 적거나
//      환경변수 OPENAI_API_KEY 를 설정합니다.
//      (선택) OPENAI_MODEL 로 모델을 바꿀 수 있어요. 기본은 gpt-4o.
//   2) 터미널에서:  node server.js
//   3) 브라우저에서: http://localhost:3000
//
// 외부 npm 패키지 없이 Node 내장 모듈만 사용합니다.
// (http, https, fs, path, url)
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// ------------------------------------------------------------
// .env 파일을 직접 파싱하는 간단한 헬퍼
//   - "KEY=value" 줄 단위
//   - 앞뒤 공백 / 감싼 따옴표 제거
//   - 빈 줄, # 주석 줄 무시
// ------------------------------------------------------------
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  const result = {};
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    return result; // .env 없으면 빈 객체
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 양쪽을 감싼 따옴표 제거
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// 환경변수 우선, 없으면 .env 파일에서 읽기
const fileEnv = loadEnvFile();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || fileEnv.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || fileEnv.OPENAI_MODEL || 'gpt-4o').trim();

// ------------------------------------------------------------
// JSON 응답 헬퍼
// ------------------------------------------------------------
function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ------------------------------------------------------------
// about_me.md 읽기
//   - 요청마다 읽어 최신 내용을 반영
//   - 파일이 없으면 null 반환 (호출부에서 500 처리)
// ------------------------------------------------------------
function readAboutMe() {
  const mdPath = path.join(__dirname, 'about_me.md');
  try {
    return fs.readFileSync(mdPath, 'utf8');
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// 시스템 프롬프트 구성 (about_me.md 내용을 근거로만 답하도록)
// ------------------------------------------------------------
function buildSystemPrompt(aboutMe) {
  return (
    "다음은 '김수경'이라는 사람에 대한 정보입니다. 당신은 이 정보만 근거로 사용자의 질문에 " +
    '한국어로 친절하게 답합니다. 정보에 명시되지 않은 내용은 추측하지 말고 정확히 "몰라요"라고 ' +
    '답하세요. 정보에 있는 내용은 자연스럽게 풀어서 답하세요.\n\n' +
    '=== 김수경 정보 (about_me.md) ===\n' +
    aboutMe +
    '\n=== 정보 끝 ==='
  );
}

// ------------------------------------------------------------
// OpenAI Chat Completions API 호출
//   - 내장 https 모듈 사용
//   - 성공 시 assistant content 문자열을 resolve
//   - 실패 시 reject(Error), 에러 본문은 콘솔 로깅
// ------------------------------------------------------------
function callOpenAI(systemPrompt, question) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3, // 근거 기반 답변이라 낮게 설정
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => (data += chunk));
      apiRes.on('end', () => {
        if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
          // OpenAI 에러 응답 본문을 콘솔에 로깅
          console.error(`[OpenAI 오류] status=${apiRes.statusCode} body=${data}`);
          return reject(new Error(`OpenAI API 오류 (status ${apiRes.statusCode})`));
        }
        try {
          const parsed = JSON.parse(data);
          const reply =
            parsed &&
            parsed.choices &&
            parsed.choices[0] &&
            parsed.choices[0].message &&
            parsed.choices[0].message.content;
          if (typeof reply !== 'string') {
            console.error('[OpenAI 응답 형식 이상]', data);
            return reject(new Error('OpenAI 응답에서 답변을 찾지 못했어요.'));
          }
          resolve(reply);
        } catch (e) {
          console.error('[OpenAI 응답 파싱 실패]', data);
          reject(new Error('OpenAI 응답을 해석하지 못했어요.'));
        }
      });
    });

    apiReq.on('error', (err) => {
      console.error('[OpenAI 요청 실패]', err.message);
      reject(new Error('OpenAI 서버에 연결하지 못했어요. 네트워크를 확인해 주세요.'));
    });

    apiReq.write(payload);
    apiReq.end();
  });
}

// ------------------------------------------------------------
// 요청 본문(JSON) 읽기 (크기 제한 1MB)
// ------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('요청 본문이 너무 큽니다.'));
      resolve(data);
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------
// 라우트 핸들러
// ------------------------------------------------------------

// GET /  -> index.html 반환
function serveIndex(res) {
  const indexPath = path.join(__dirname, 'index.html');
  fs.readFile(indexPath, (err, content) => {
    if (err) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'index.html 을 찾을 수 없습니다. 프론트엔드 파일이 준비되면 다시 시도해 주세요.'
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// POST /api/ask -> about_me.md 기반 OpenAI 호출
async function handleAsk(req, res) {
  // 키가 없으면 바로 500
  if (!OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error:
        'OPENAI_API_KEY 가 설정되지 않았습니다. .env 파일에 OPENAI_API_KEY=sk-... 를 넣어 주세요.',
    });
  }

  // about_me.md 읽기 (없으면 500)
  const aboutMe = readAboutMe();
  if (aboutMe === null) {
    return sendJson(res, 500, { error: 'about_me.md를 찾을 수 없어요.' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: '요청 본문을 읽지 못했어요.' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return sendJson(res, 400, { error: '요청 본문이 올바른 JSON이 아니에요.' });
  }

  const question = body && typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return sendJson(res, 400, { error: '질문을 입력해 주세요.' });
  }

  try {
    const systemPrompt = buildSystemPrompt(aboutMe);
    const answer = await callOpenAI(systemPrompt, question);
    return sendJson(res, 200, { answer });
  } catch (err) {
    return sendJson(res, 500, {
      error: err.message || '답변을 만드는 중 문제가 생겼어요.',
    });
  }
}

// ------------------------------------------------------------
// 서버
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  // CORS: index.html 을 파일(file://)로 직접 열어도 localhost 서버를 호출할 수 있게 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 프리플라이트(OPTIONS) 요청은 바로 응답
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/') {
    return serveIndex(res);
  }

  if (req.method === 'POST' && pathname === '/api/ask') {
    return handleAsk(req, res);
  }

  // 그 외 -> 404
  sendJson(res, 404, { error: '요청하신 경로를 찾을 수 없어요.' });
});

server.listen(PORT, () => {
  console.log('About-Me Q&A 서버 실행: http://localhost:' + PORT);
  console.log('사용 모델: ' + OPENAI_MODEL);
  if (!OPENAI_API_KEY) {
    console.log('');
    console.log('[안내] OPENAI_API_KEY 가 아직 설정되지 않았어요.');
    console.log('       같은 폴더의 .env 파일에 아래처럼 넣어 주세요:');
    console.log('       OPENAI_API_KEY=sk-여기에-본인-키');
    console.log('       (또는 환경변수 OPENAI_API_KEY 설정)');
    console.log('       키가 없으면 질문 요청은 500 오류를 돌려줍니다.');
  }
});
