// 익명 공감 게시판 앱 - 백엔드 서버
// 모든 데이터를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)
// 익명이므로 작성자/IP/세션 정보는 저장하지 않는다.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'index.html');

// 허용 카테고리 (그 외 값은 '기타'로 대체)
const ALLOWED_CATEGORIES = ['고민', '칭찬', '응원', '기타'];

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
function rowToPost(r) {
  return {
    id: r.id,
    category: r.category || '기타',
    content: r.content || '',
    likes: r.likes !== null && r.likes !== undefined ? Number(r.likes) : 0,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

// ---------- 테이블 생성 ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id         SERIAL PRIMARY KEY,
      category   TEXT NOT NULL DEFAULT '기타',
      content    TEXT NOT NULL,
      likes      INTEGER NOT NULL DEFAULT 0,
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
        '<h1>익명 공감 게시판 API 서버</h1><p>index.html 이 아직 준비되지 않았습니다.</p>'
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------- 게시글 API ----------
// GET /api/posts?sort=latest|likes
async function handlePostList(res, sort) {
  let orderBy;
  if (sort === 'likes') {
    orderBy = 'ORDER BY likes DESC, created_at DESC';
  } else {
    // 기본값 latest
    orderBy = 'ORDER BY created_at DESC';
  }
  const { rows } = await pool.query(`SELECT * FROM posts ${orderBy}`);
  sendJSON(res, 200, rows.map(rowToPost));
}

// POST /api/posts  body: { category, content }
async function handlePostCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return sendJSON(res, 400, { error: '내용을 입력해 주세요.' });
  }

  // category 가 허용값이 아니면 '기타'로 대체
  let category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!ALLOWED_CATEGORIES.includes(category)) {
    category = '기타';
  }

  const { rows } = await pool.query(
    'INSERT INTO posts (category, content) VALUES ($1, $2) RETURNING *',
    [category, content]
  );
  sendJSON(res, 201, rowToPost(rows[0]));
}

// POST /api/posts/:id/like
async function handlePostLike(res, id) {
  const numId = Number(id);
  if (!numId || !Number.isInteger(numId)) {
    return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
  }
  const { rows } = await pool.query(
    'UPDATE posts SET likes = likes + 1 WHERE id = $1 RETURNING *',
    [numId]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 id의 글을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, rowToPost(rows[0]));
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // 공감 +1 (반드시 /api/posts 생성 라우트보다 먼저 매칭)
    const likeMatch = pathname.match(/^\/api\/posts\/([^/]+)\/like$/);
    if (likeMatch) {
      if (method === 'POST') {
        return await handlePostLike(res, decodeURIComponent(likeMatch[1]));
      }
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // 목록 조회 / 글 작성
    if (pathname === '/api/posts') {
      if (method === 'GET') {
        const sort = parsedUrl.searchParams.get('sort') || 'latest';
        return await handlePostList(res, sort);
      }
      if (method === 'POST') return await handlePostCreate(req, res);
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

// 로컬 실행 시에만 서버 시작. (require 시에는 app export 만)
if (require.main === module) {
  initDbWithRetry()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`익명 공감 게시판 서버 실행 중 (Supabase 저장): http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('DB 초기화 최종 실패:', err.message);
      process.exit(1);
    });
}

module.exports = server;
