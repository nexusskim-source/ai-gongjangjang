// 커뮤니티 게시판 앱 - 로컬 백엔드 서버 (Node 내장 http)
// 회원가입/로그인 + 게시글 CRUD. 데이터는 PostgreSQL(Supabase)에 저장한다.
// ⚠️ 이 Supabase 는 여러 앱이 공유한다. 이 앱은 전용 테이블
//    (community_users, community_posts) 만 사용한다.
// 배포(Vercel)는 api/*.js 서버리스 함수로 동작하며, 여기와 동일한 SQL/로직을 공유한다.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const auth = require('./auth');

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
// 목록/상세 쿼리는 community_users 를 JOIN 해서 author_name 을 함께 가져온다.
function rowToPost(r, currentUserId) {
  return {
    id: r.id,
    title: r.title || '',
    content: r.content || '',
    authorId: r.user_id,
    authorName: r.author_name || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    mine: currentUserId != null && Number(r.user_id) === Number(currentUserId),
  };
}

// ---------- 테이블 생성 ----------
async function initDb() {
  // community_users
  await auth.ensureAuthSchema(pool);
  // community_posts (작성자 = community_users.id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES community_users(id),
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      res.end('<h1>커뮤니티 게시판 API 서버</h1><p>index.html 이 아직 준비되지 않았습니다.</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------- 인증 ----------
function requireUser(req, res) {
  const user = auth.getUserFromReq(req);
  if (!user) {
    sendJSON(res, 401, { success: false, message: '로그인이 필요합니다.' });
    return null;
  }
  return user;
}

// ---------- 게시글 API ----------
// GET /api/posts  (목록, 최신순)
async function handlePostList(res, user) {
  const { rows } = await pool.query(
    `SELECT p.*, u.username AS author_name
       FROM community_posts p
       JOIN community_users u ON u.id = p.user_id
      ORDER BY p.created_at DESC`
  );
  sendJSON(res, 200, rows.map((r) => rowToPost(r, user.id)));
}

// POST /api/posts  body: { title, content }
async function handlePostCreate(req, res, user) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!title || !content) {
    return sendJSON(res, 400, { success: false, message: '제목과 내용을 모두 입력해 주세요.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO community_posts (user_id, title, content) VALUES ($1, $2, $3) RETURNING *`,
    [user.id, title, content]
  );
  // 방금 만든 글의 작성자는 현재 사용자
  const row = { ...rows[0], author_name: user.username };
  sendJSON(res, 201, rowToPost(row, user.id));
}

// GET /api/posts/:id  (상세 1건)
async function handlePostDetail(res, user, id) {
  const numId = Number(id);
  if (!numId || !Number.isInteger(numId)) {
    return sendJSON(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
  }
  const { rows } = await pool.query(
    `SELECT p.*, u.username AS author_name
       FROM community_posts p
       JOIN community_users u ON u.id = p.user_id
      WHERE p.id = $1`,
    [numId]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { success: false, message: '해당 글을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, rowToPost(rows[0], user.id));
}

// PUT /api/posts/:id  body: { title, content }  (본인 글만)
async function handlePostUpdate(req, res, user, id) {
  const numId = Number(id);
  if (!numId || !Number.isInteger(numId)) {
    return sendJSON(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!title || !content) {
    return sendJSON(res, 400, { success: false, message: '제목과 내용을 모두 입력해 주세요.' });
  }

  const cur = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [numId]);
  if (cur.rows.length === 0) {
    return sendJSON(res, 404, { success: false, message: '해당 글을 찾을 수 없습니다.' });
  }
  if (Number(cur.rows[0].user_id) !== Number(user.id)) {
    return sendJSON(res, 403, { success: false, message: '본인 글만 수정할 수 있습니다.' });
  }

  const { rows } = await pool.query(
    `UPDATE community_posts SET title = $1, content = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [title, content, numId]
  );
  const row = { ...rows[0], author_name: user.username };
  sendJSON(res, 200, rowToPost(row, user.id));
}

// DELETE /api/posts/:id  (본인 글만)
async function handlePostDelete(res, user, id) {
  const numId = Number(id);
  if (!numId || !Number.isInteger(numId)) {
    return sendJSON(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
  }
  const cur = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [numId]);
  if (cur.rows.length === 0) {
    return sendJSON(res, 404, { success: false, message: '해당 글을 찾을 수 없습니다.' });
  }
  if (Number(cur.rows[0].user_id) !== Number(user.id)) {
    return sendJSON(res, 403, { success: false, message: '본인 글만 삭제할 수 있습니다.' });
  }
  await pool.query('DELETE FROM community_posts WHERE id = $1', [numId]);
  sendJSON(res, 200, { success: true, id: numId });
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // ---- 인증 (로그인 불필요) ----
    if (pathname === '/api/auth/signup' || pathname === '/api/auth/login') {
      if (method !== 'POST') {
        return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { success: false, message: '잘못된 요청 형식입니다. (' + err.message + ')' });
      }
      try {
        const isSignup = pathname.endsWith('/signup');
        const result = isSignup ? await auth.signup(pool, body) : await auth.login(pool, body);
        return sendJSON(res, isSignup ? 201 : 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('인증 처리 오류:', err);
        return sendJSON(res, status, { success: false, message: err.message || '서버 오류' });
      }
    }

    // ---- 게시글 개별 (:id) — 컬렉션보다 먼저 매칭 ----
    const idMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
    if (idMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(idMatch[1]);
      if (method === 'GET') return await handlePostDetail(res, user, id);
      if (method === 'PUT') return await handlePostUpdate(req, res, user, id);
      if (method === 'DELETE') return await handlePostDelete(res, user, id);
      return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
    }

    // ---- 게시글 컬렉션 ----
    if (pathname === '/api/posts') {
      const user = requireUser(req, res);
      if (!user) return;
      if (method === 'GET') return await handlePostList(res, user);
      if (method === 'POST') return await handlePostCreate(req, res, user);
      return sendJSON(res, 405, { success: false, message: '허용되지 않은 메서드입니다.' });
    }

    // ---- 정적 파일 (index.html) ----
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveIndex(res);
    }

    sendJSON(res, 404, { success: false, message: '페이지를 찾을 수 없습니다.' });
  } catch (err) {
    console.error('서버 오류:', err);
    sendJSON(res, 500, { success: false, message: '서버 내부 오류가 발생했습니다: ' + err.message });
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
        console.log(`커뮤니티 게시판 서버 실행 중 (Supabase 저장): http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('DB 초기화 최종 실패:', err.message);
      process.exit(1);
    });
}

module.exports = server;
