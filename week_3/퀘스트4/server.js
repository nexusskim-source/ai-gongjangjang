// ============================================================
// AI 별명 생성기 - 백엔드 서버
//
// 사용자의 이름·성격·취미를 받아 OpenAI로 재치 있는
// 한국어 별명 6개를 만들어 돌려줍니다.
//
// 실행법:
//   1) 같은 폴더에 .env 파일을 두고 OPENAI_API_KEY=sk-... 를 적거나
//      환경변수 OPENAI_API_KEY 를 설정합니다.
//   2) 터미널에서:  node server.js
//   3) 브라우저에서: http://localhost:3000
//
// 외부 npm 패키지 없이 Node 내장 모듈만 사용합니다.
// (http, https, fs, path, url)
// API 키는 서버에서만 사용하며 절대 프론트엔드로 보내지 않습니다.
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// ------------------------------------------------------------
// 시스템 프롬프트 (작명 전문가)
// ------------------------------------------------------------
const SYSTEM_PROMPT =
  '너는 사람의 이름·성격·취미를 보고 재치 있고 유쾌한 한국어 \'별명\'을 지어주는 작명 전문가다. ' +
  '너무 무례하지 않게, 위트 있고 긍정적으로. ' +
  '반드시 아래 JSON 형식으로만 답하라: ' +
  '{"nicknames":[{"nickname":"별명","reason":"왜 이 별명인지 짧고 재밌는 한 줄 설명"}, ...]} ' +
  '별명은 6개 생성하라.';

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

// 환경변수 우선, 없으면 .env 파일에서 읽기 (trailing newline 방지 위해 trim)
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
// OpenAI Chat Completions API 호출
//   - 내장 https 모듈 사용
//   - response_format: json_object 강제
//   - 성공 시 assistant content 문자열을 resolve
//   - 실패 시 reject(Error), non-2xx 본문은 콘솔에 로깅
// ------------------------------------------------------------
function callOpenAI(userContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
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
            return reject(new Error('OpenAI 응답에서 결과를 찾지 못했어요.'));
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

// POST /api/nickname -> OpenAI 호출해 별명 생성
async function handleNickname(req, res) {
  // 키가 없으면 바로 500
  if (!OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error:
        'OPENAI_API_KEY 가 설정되지 않았습니다. .env 파일에 OPENAI_API_KEY=sk-... 를 넣어 주세요.',
    });
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

  const name = body && typeof body.name === 'string' ? body.name.trim() : '';
  const personality =
    body && typeof body.personality === 'string' ? body.personality.trim() : '';
  const hobbies = body && typeof body.hobbies === 'string' ? body.hobbies.trim() : '';

  if (!name) {
    return sendJson(res, 400, { error: '이름을 입력해 주세요.' });
  }

  // 유저 메시지 구성
  const userContent =
    `다음 사람에게 어울리는 재치 있는 한국어 별명 6개를 지어줘.\n` +
    `- 이름: ${name}\n` +
    `- 성격: ${personality || '(정보 없음)'}\n` +
    `- 취미: ${hobbies || '(정보 없음)'}`;

  let reply;
  try {
    reply = await callOpenAI(userContent);
  } catch (err) {
    return sendJson(res, 500, {
      error: err.message || '별명을 만드는 중 문제가 생겼어요.',
    });
  }

  // OpenAI content(JSON 문자열) 파싱 -> nicknames 배열 정제
  try {
    const parsed = JSON.parse(reply);
    const list = Array.isArray(parsed && parsed.nicknames) ? parsed.nicknames : [];
    const nicknames = list
      .filter(
        (item) =>
          item &&
          typeof item.nickname === 'string' &&
          typeof item.reason === 'string'
      )
      .map((item) => ({ nickname: item.nickname, reason: item.reason }));

    if (nicknames.length === 0) {
      console.error('[별명 결과 비어있음]', reply);
      return sendJson(res, 500, {
        error: '별명을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    return sendJson(res, 200, { nicknames });
  } catch (e) {
    console.error('[별명 응답 파싱 실패]', reply);
    return sendJson(res, 500, {
      error: 'AI 응답을 해석하지 못했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
}

// ------------------------------------------------------------
// 서버
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  // CORS: index.html 을 파일(file://)로 직접 열어도 localhost 서버 호출 허용
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

  if (req.method === 'POST' && pathname === '/api/nickname') {
    return handleNickname(req, res);
  }

  // 그 외 -> 404
  sendJson(res, 404, { error: '요청하신 경로를 찾을 수 없어요.' });
});

server.listen(PORT, () => {
  console.log('별명 생성기 서버 실행: http://localhost:' + PORT);
  console.log('사용 모델: ' + OPENAI_MODEL);
  if (!OPENAI_API_KEY) {
    console.log('');
    console.log('[안내] OPENAI_API_KEY 가 아직 설정되지 않았어요.');
    console.log('       같은 폴더의 .env 파일에 아래처럼 넣어 주세요:');
    console.log('       OPENAI_API_KEY=sk-여기에-본인-키');
    console.log('       (또는 환경변수 OPENAI_API_KEY 설정)');
    console.log('       키가 없으면 /api/nickname 요청은 500 오류를 돌려줍니다.');
  }
});
