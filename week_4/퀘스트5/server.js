// 밸런스 게임(둘 중 하나 투표) 앱 - 백엔드 서버
// 모든 데이터를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)
// index.html 은 다른 에이전트가 생성하므로 여기서는 정적 서빙만 담당한다.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'index.html');

if (!process.env.DATABASE_URL) {
  console.error('환경변수 DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
// 환경변수 끝에 붙는 개행 방지를 위해 .trim() 적용.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// ---------- DB 행(snake_case) -> 클라이언트 JSON(camelCase) ----------
// 프론트의 퍼센트 계산 편의를 위해 total(= votesA + votesB) 도 함께 반환한다.
function rowToQuestion(r) {
  const votesA = r.votes_a !== null && r.votes_a !== undefined ? Number(r.votes_a) : 0;
  const votesB = r.votes_b !== null && r.votes_b !== undefined ? Number(r.votes_b) : 0;
  return {
    id: r.id,
    optionA: r.option_a || '',
    optionB: r.option_b || '',
    votesA: votesA,
    votesB: votesB,
    total: votesA + votesB,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

// ---------- 테이블 생성 ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id         SERIAL PRIMARY KEY,
      option_a   TEXT NOT NULL,
      option_b   TEXT NOT NULL,
      votes_a    INTEGER NOT NULL DEFAULT 0,
      votes_b    INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// ---------- 응답/요청 헬퍼 ----------
function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(INDEX_FILE, (err, content) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>밸런스 게임 API 서버</h1><p>index.html 이 아직 준비되지 않았습니다.</p>'
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------- 질문 API ----------
// GET /api/questions  -> 전체 질문 (최신순)
async function handleQuestionList(res) {
  const { rows } = await pool.query('SELECT * FROM questions ORDER BY created_at DESC, id DESC');
  sendJSON(res, 200, rows.map(rowToQuestion));
}

// POST /api/questions  body: { optionA, optionB }
async function handleQuestionCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }

  const optionA = typeof body.optionA === 'string' ? body.optionA.trim() : '';
  const optionB = typeof body.optionB === 'string' ? body.optionB.trim() : '';
  if (!optionA || !optionB) {
    return sendJSON(res, 400, { error: '두 선택지를 모두 입력해 주세요.' });
  }

  const { rows } = await pool.query(
    'INSERT INTO questions (option_a, option_b) VALUES ($1, $2) RETURNING *',
    [optionA, optionB]
  );
  sendJSON(res, 201, rowToQuestion(rows[0]));
}

// POST /api/questions/:id/vote  body: { choice: 'a' | 'b' }
async function handleQuestionVote(req, res, id) {
  const numId = Number(id);
  if (!numId || !Number.isInteger(numId)) {
    return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }

  const choice = typeof body.choice === 'string' ? body.choice.trim().toLowerCase() : '';
  if (choice !== 'a' && choice !== 'b') {
    return sendJSON(res, 400, { error: "choice 는 'a' 또는 'b' 여야 합니다." });
  }

  const column = choice === 'a' ? 'votes_a' : 'votes_b';
  const { rows } = await pool.query(
    `UPDATE questions SET ${column} = ${column} + 1 WHERE id = $1 RETURNING *`,
    [numId]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 id의 질문을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, rowToQuestion(rows[0]));
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // 투표 (반드시 /api/questions 생성/목록 라우트보다 먼저 매칭)
    const voteMatch = pathname.match(/^\/api\/questions\/([^/]+)\/vote$/);
    if (voteMatch) {
      if (method === 'POST') {
        return await handleQuestionVote(req, res, decodeURIComponent(voteMatch[1]));
      }
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // 목록 조회 / 질문 작성
    if (pathname === '/api/questions') {
      if (method === 'GET') return await handleQuestionList(res);
      if (method === 'POST') return await handleQuestionCreate(req, res);
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // 정적 파일 (index.html)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveIndex(res);
    }

    sendJSON(res, 404, { error: '페이지를 찾을 수 없습니다.' });
  } catch (err) {
    console.error('서버 오류:', err);
    sendJSON(res, 500, { error: '서버 내부 오류가 발생했습니다: ' + err.message });
  }
});

// ---------- 서버 시작 ----------
// Supabase pooler 가 가끔 첫 연결을 28P01 로 거부하므로 몇 번 재시도한다.
async function initDbWithRetry(retries = 4, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await initDb();
      return;
    } catch (err) {
      console.warn(`DB 초기화 시도 ${attempt}/${retries} 실패: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// 로컬 실행 시에만 서버 시작. (require 시에는 server export 만)
if (require.main === module) {
  initDbWithRetry()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`밸런스 게임 서버 실행 중 (Supabase 저장): http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('DB 초기화 최종 실패:', err.message);
      process.exit(1);
    });
}

module.exports = server;
