// ============================================================
// 르느와르 화풍 AI 이미지 생성기 - 백엔드 서버
//
// 실행법:
//   1) 같은 폴더 .env 에 OPENAI_API_KEY=sk-... (또는 환경변수)
//   2) 터미널:  node server.js
//   3) 브라우저: http://localhost:3000
//
// 외부 npm 패키지 없이 Node 내장 모듈(http, https, fs, path, url)만 사용.
// 프론트(index.html)가 POST /api/generate { prompt } 를 보내면
// 르느와르 화풍을 입혀 OpenAI 이미지 API(gpt-image-1)로 그림을 생성해
// data URL 형태의 이미지로 돌려준다.
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// ------------------------------------------------------------
// 르느와르 화풍 스타일 지시문 (사용자 프롬프트 앞에 붙는다)
// ------------------------------------------------------------
const RENOIR_STYLE =
  'An impressionist oil painting in the style of Pierre-Auguste Renoir. ' +
  'Soft, feathery brushstrokes, warm dappled sunlight, luminous pastel palette, ' +
  'rosy skin tones, vibrant yet gentle colors, romantic and joyful atmosphere, ' +
  'visible canvas texture, 19th-century French Impressionism. ' +
  'Scene to depict: ';

// ------------------------------------------------------------
// .env 파일 파싱 (KEY=value, 따옴표/공백/주석 처리)
// ------------------------------------------------------------
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  const result = {};
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
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

const fileEnv = loadEnvFile();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || fileEnv.OPENAI_API_KEY || '').trim();
const IMAGE_MODEL = (process.env.OPENAI_IMAGE_MODEL || fileEnv.OPENAI_IMAGE_MODEL || 'gpt-image-1').trim();

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
// OpenAI 이미지 생성 API 호출
//   - gpt-image-1 은 b64_json 으로 이미지를 돌려준다
//   - 성공 시 data URL 문자열(resolve), 실패 시 reject(Error)
// ------------------------------------------------------------
function generateImage(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: IMAGE_MODEL,
      prompt: RENOIR_STYLE + prompt,
      size: '1024x1024',
      quality: 'high',
      n: 1,
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
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
          console.error(`[OpenAI 이미지 오류] status=${apiRes.statusCode} body=${data}`);
          return reject(new Error(`이미지 생성 API 오류 (status ${apiRes.statusCode})`));
        }
        try {
          const parsed = JSON.parse(data);
          const b64 = parsed && parsed.data && parsed.data[0] && parsed.data[0].b64_json;
          if (typeof b64 !== 'string') {
            console.error('[OpenAI 이미지 응답 형식 이상]', data.slice(0, 300));
            return reject(new Error('이미지 데이터를 찾지 못했어요.'));
          }
          resolve('data:image/png;base64,' + b64);
        } catch (e) {
          console.error('[OpenAI 이미지 응답 파싱 실패]', data.slice(0, 300));
          reject(new Error('이미지 응답을 해석하지 못했어요.'));
        }
      });
    });

    // 이미지 생성은 오래 걸릴 수 있어 넉넉히 180초 타임아웃
    apiReq.setTimeout(180000, () => {
      apiReq.destroy(new Error('이미지 생성이 시간 초과되었어요. 다시 시도해 주세요.'));
    });

    apiReq.on('error', (err) => {
      console.error('[OpenAI 이미지 요청 실패]', err.message);
      reject(new Error(err.message || 'OpenAI 서버에 연결하지 못했어요.'));
    });

    apiReq.write(payload);
    apiReq.end();
  });
}

// ------------------------------------------------------------
// 요청 본문 읽기 (1MB 제한)
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
// GET / -> index.html
// ------------------------------------------------------------
function serveIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
    if (err) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 을 찾을 수 없습니다.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ------------------------------------------------------------
// POST /api/generate -> 이미지 생성
// ------------------------------------------------------------
async function handleGenerate(req, res) {
  if (!OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error: 'OPENAI_API_KEY 가 설정되지 않았습니다. .env 파일에 OPENAI_API_KEY=sk-... 를 넣어 주세요.',
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

  const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return sendJson(res, 400, { error: '무엇을 그릴지 prompt 를 입력해 주세요.' });
  }

  try {
    const image = await generateImage(prompt);
    return sendJson(res, 200, { image });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '이미지를 만드는 중 문제가 생겼어요.' });
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const pathname = url.parse(req.url).pathname;

  if (req.method === 'GET' && pathname === '/') {
    return serveIndex(res);
  }
  if (req.method === 'POST' && pathname === '/api/generate') {
    return handleGenerate(req, res);
  }

  sendJson(res, 404, { error: '요청하신 경로를 찾을 수 없어요.' });
});

server.listen(PORT, () => {
  console.log('르느와르 이미지 생성기 서버 실행: http://localhost:' + PORT);
  console.log('이미지 모델: ' + IMAGE_MODEL);
  if (!OPENAI_API_KEY) {
    console.log('');
    console.log('[안내] OPENAI_API_KEY 가 아직 설정되지 않았어요. .env 에 OPENAI_API_KEY=sk-... 를 넣어 주세요.');
  }
});
