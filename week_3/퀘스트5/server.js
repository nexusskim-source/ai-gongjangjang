// ============================================================
// 신비로운 해몽가 AI - 백엔드 서버
//
// 실행법:
//   1) 같은 폴더에 .env 파일을 두고 OPENAI_API_KEY=sk-... 를 적거나
//      환경변수 OPENAI_API_KEY 를 설정합니다.
//      (모델을 바꾸려면 OPENAI_MODEL=gpt-4o 처럼 추가, 기본은 gpt-4o)
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
// 시스템 프롬프트 (신비로운 점술가/해몽가)
// ------------------------------------------------------------
const SYSTEM_PROMPT =
  '너는 신비로운 점술가이자 해몽가다. 오래된 동양 해몽 전통과 신비로운 직관으로 꿈을 풀이한다. ' +
  "말투는 신비롭고 운치 있으며 점잖고 다정하다('~이로다', '~하리라', '~의 기운이 감도는구나' 같은 점술가 말투를 자연스럽게 섞어라). " +
  '사용자의 꿈을 듣고 길몽인지 흉몽인지 판단하고, 그 의미를 신비롭게 풀이하며, 오늘 하루를 위한 한 줄 조언을 준다. ' +
  '반드시 아래 JSON 형식으로만 답하라: ' +
  '{"omen":"길몽 또는 흉몽 또는 반길몽", "interpretation":"신비로운 해몽 풀이 2~4문장", "advice":"오늘의 한 줄 조언"} ' +
  "omen 값은 정확히 '길몽','흉몽','반길몽' 중 하나여야 한다.";

const VALID_OMENS = ['길몽', '흉몽', '반길몽'];

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
//   - response_format: json_object 로 JSON 응답 강제
//   - 성공 시 assistant content 문자열을 resolve
//   - 실패 시 reject(Error)
// ------------------------------------------------------------
function callOpenAI(dreamText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: dreamText },
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
            return reject(new Error('OpenAI 응답에서 해몽을 찾지 못했어요.'));
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

// POST /api/dream -> OpenAI 해몽 호출
async function handleDream(req, res) {
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

  const dream = body && typeof body.dream === 'string' ? body.dream.trim() : '';
  if (!dream) {
    return sendJson(res, 400, { error: '꿈 내용을 입력해 주세요.' });
  }

  let reply;
  try {
    reply = await callOpenAI(dream);
  } catch (err) {
    return sendJson(res, 500, {
      error: err.message || '해몽을 풀이하는 중 문제가 생겼어요.',
    });
  }

  // OpenAI 가 돌려준 JSON 문자열 파싱
  let result;
  try {
    result = JSON.parse(reply);
  } catch (e) {
    console.error('[해몽 JSON 파싱 실패]', reply);
    return sendJson(res, 500, { error: '해몽 결과를 해석하지 못했어요.' });
  }

  const omen = result && result.omen;
  const interpretation = result && result.interpretation;
  const advice = result && result.advice;

  if (
    typeof omen !== 'string' ||
    typeof interpretation !== 'string' ||
    typeof advice !== 'string'
  ) {
    console.error('[해몽 형식 이상]', reply);
    return sendJson(res, 500, { error: '해몽 결과의 형식이 올바르지 않아요.' });
  }

  // omen 이 정해진 셋 중 하나가 아니면 '반길몽'으로 보정
  const safeOmen = VALID_OMENS.includes(omen.trim()) ? omen.trim() : '반길몽';

  return sendJson(res, 200, {
    omen: safeOmen,
    interpretation: interpretation,
    advice: advice,
  });
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

  if (req.method === 'POST' && pathname === '/api/dream') {
    return handleDream(req, res);
  }

  // 그 외 -> 404
  sendJson(res, 404, { error: '요청하신 경로를 찾을 수 없어요.' });
});

server.listen(PORT, () => {
  console.log('해몽가 서버 실행: http://localhost:' + PORT);
  console.log('사용 모델: ' + OPENAI_MODEL);
  if (!OPENAI_API_KEY) {
    console.log('');
    console.log('[안내] OPENAI_API_KEY 가 아직 설정되지 않았어요.');
    console.log('       같은 폴더의 .env 파일에 아래처럼 넣어 주세요:');
    console.log('       OPENAI_API_KEY=sk-여기에-본인-키');
    console.log('       (또는 환경변수 OPENAI_API_KEY 설정)');
    console.log('       키가 없으면 해몽 요청은 500 오류를 돌려줍니다.');
  }
});
