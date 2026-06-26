// ============================================================
// 나만의 챗GPT - 백엔드 서버 (유시민 사회학자 챗봇)
//
// 실행법:
//   1) 같은 폴더에 .env 파일을 두고 OPENAI_API_KEY=sk-... 를 적거나
//      환경변수 OPENAI_API_KEY 를 설정합니다.
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
// 시스템 프롬프트 (유시민 작가풍 사회학자)
// ------------------------------------------------------------
const SYSTEM_PROMPT = `당신은 유시민 작가를 닮은 사회학자입니다. 사용자의 어떤 질문에도 사회학자의 시선으로 답합니다.

답변 원칙:
1. 개인의 문제처럼 보이는 일도 사회구조·제도·역사의 맥락 속에서 해석한다.
2. 왜 그런 현상이 생겼는지 배경과 원인을 차근차근 짚어준다. 결론만 던지지 않는다.
3. 어려운 개념도 일상의 쉬운 비유로 풀어 설명한다.
4. 따뜻하지만 핵심을 찌르는 통찰을 준다. 평범한 사람들의 처지에 공감한다.
5. 한쪽으로 단정하기보다 근거를 들어 균형 있게, 그러나 분명한 관점을 가지고 말한다.
6. 한국어로, 지적이면서도 친근한 말투("~죠", "~거예요", "~겠지요")로 대화하듯 답한다. 너무 길게 늘어놓지 말고, 핵심을 짚되 필요하면 구체적 사례를 든다.`;

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
// OpenAI Chat Completions API 호출
//   - 내장 https 모듈 사용
//   - 성공 시 assistant content 문자열을 resolve
//   - 실패 시 reject(Error)
// ------------------------------------------------------------
function callOpenAI(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      // 참고: gpt-5.x 계열은 temperature 기본값(1)만 지원하므로 temperature를 보내지 않는다.
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
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
          console.error(
            `[OpenAI 오류] status=${apiRes.statusCode} body=${data}`
          );
          return reject(
            new Error(`OpenAI API 오류 (status ${apiRes.statusCode})`)
          );
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

// POST /api/chat -> OpenAI 호출
async function handleChat(req, res) {
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

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, 400, {
      error: 'messages 배열이 필요해요. [{ role, content }, ...] 형식으로 보내 주세요.',
    });
  }

  // role/content 정제 (user/assistant 만 허용)
  const messages = body.messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .map((m) => ({ role: m.role, content: m.content }));

  if (messages.length === 0) {
    return sendJson(res, 400, {
      error: '유효한 메시지가 없어요. role 은 user/assistant, content 는 문자열이어야 해요.',
    });
  }

  try {
    const reply = await callOpenAI(messages);
    return sendJson(res, 200, { reply });
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

  if (req.method === 'POST' && pathname === '/api/chat') {
    return handleChat(req, res);
  }

  // 그 외 -> 404
  sendJson(res, 404, { error: '요청하신 경로를 찾을 수 없어요.' });
});

server.listen(PORT, () => {
  console.log('유시민 챗봇 서버 실행: http://localhost:' + PORT);
  console.log('사용 모델: ' + OPENAI_MODEL);
  if (!OPENAI_API_KEY) {
    console.log('');
    console.log('[안내] OPENAI_API_KEY 가 아직 설정되지 않았어요.');
    console.log('       같은 폴더의 .env 파일에 아래처럼 넣어 주세요:');
    console.log('       OPENAI_API_KEY=sk-여기에-본인-키');
    console.log('       (또는 환경변수 OPENAI_API_KEY 설정)');
    console.log('       키가 없으면 채팅 요청은 500 오류를 돌려줍니다.');
  }
});
