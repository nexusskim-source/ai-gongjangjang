// todo-app-db 백엔드 서버
// 데이터를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const VALID_STATUS = ['진행 전', '진행 중', '완료'];

if (!process.env.DATABASE_URL) {
  console.error('환경변수 DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// DB 행(snake_case) -> 클라이언트 JSON(camelCase)
function rowToTodo(r) {
  return {
    id: r.id,
    title: r.title,
    dueDate: r.due_date || '',
    status: r.status,
    memo: r.memo || '',
  };
}

// 테이블 생성 (todos + users, todos.user_id)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id       SERIAL PRIMARY KEY,
      title    TEXT NOT NULL,
      due_date TEXT DEFAULT '',
      status   TEXT NOT NULL DEFAULT '진행 전',
      memo     TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // users 테이블 + todos.user_id 컬럼 (사용자별 분리)
  await auth.ensureAuthSchema(pool);
}

// 입력 정규화
function normalize({ title = '', dueDate = '', status = '진행 전', memo = '' }) {
  const s = String(status).trim();
  return {
    title: String(title).trim(),
    dueDate: String(dueDate).trim(),
    status: VALID_STATUS.includes(s) ? s : '진행 전',
    memo: String(memo).trim(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('잘못된 JSON 형식입니다.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  try {
    // ---------- 인증 (회원가입 / 로그인) ----------
    if (req.method === 'POST' && (url === '/api/auth/signup' || url === '/api/auth/login')) {
      try {
        const body = await readJsonBody(req);
        const result = url.endsWith('/signup')
          ? await auth.signup(pool, body)
          : await auth.login(pool, body);
        return sendJson(res, url.endsWith('/signup') ? 201 : 200, result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('인증 처리 오류:', err);
        return sendJson(res, status, { success: false, message: err.message || '서버 오류' });
      }
    }

    // ---------- 할 일 API: 여기부터는 로그인 필수 ----------
    if (url === '/api/todos') {
      const user = auth.getUserFromReq(req);
      if (!user) return sendJson(res, 401, { success: false, message: '로그인이 필요합니다.' });

      // 목록 (본인 것만)
      if (req.method === 'GET') {
        const { rows } = await pool.query(
          'SELECT * FROM todos WHERE user_id = $1 ORDER BY id ASC',
          [user.id]
        );
        return sendJson(res, 200, rows.map(rowToTodo));
      }

      // 추가 (본인 소유로)
      if (req.method === 'POST') {
        const todo = normalize(await readJsonBody(req));
        if (!todo.title) return sendJson(res, 400, { success: false, message: '제목은 필수입니다.' });
        const { rows } = await pool.query(
          'INSERT INTO todos (title, due_date, status, memo, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [todo.title, todo.dueDate, todo.status, todo.memo, user.id]
        );
        return sendJson(res, 201, { success: true, ...rowToTodo(rows[0]) });
      }

      // 수정 (본인 것만, 부분 수정)
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!id) return sendJson(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });

        const cur = await pool.query('SELECT * FROM todos WHERE id = $1 AND user_id = $2', [id, user.id]);
        if (cur.rows.length === 0) {
          return sendJson(res, 404, { success: false, message: '해당 할 일을 찾을 수 없습니다.' });
        }
        const prev = rowToTodo(cur.rows[0]);
        const merged = normalize({
          title: body.title !== undefined ? body.title : prev.title,
          dueDate: body.dueDate !== undefined ? body.dueDate : prev.dueDate,
          status: body.status !== undefined ? body.status : prev.status,
          memo: body.memo !== undefined ? body.memo : prev.memo,
        });
        if (!merged.title) return sendJson(res, 400, { success: false, message: '제목은 비울 수 없습니다.' });

        const { rows } = await pool.query(
          'UPDATE todos SET title=$1, due_date=$2, status=$3, memo=$4 WHERE id=$5 AND user_id=$6 RETURNING *',
          [merged.title, merged.dueDate, merged.status, merged.memo, id, user.id]
        );
        return sendJson(res, 200, { success: true, ...rowToTodo(rows[0]) });
      }

      // 삭제 (본인 것만)
      if (req.method === 'DELETE') {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!id) return sendJson(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
        const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1 AND user_id = $2', [id, user.id]);
        if (rowCount === 0) {
          return sendJson(res, 404, { success: false, message: '해당 할 일을 찾을 수 없습니다.' });
        }
        return sendJson(res, 200, { success: true, id });
      }
    }

    // 정적 파일: 루트 → index.html
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      const data = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(data);
    }

    // 그 외 정적 파일
    if (req.method === 'GET') {
      const safePath = path.normalize(decodeURIComponent(url)).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, safePath);
      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('접근 금지');
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not Found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
        }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error('요청 처리 오류:', err);
    sendJson(res, 500, { success: false, message: '서버 오류: ' + err.message });
  }
});

// DB 초기화 — Supabase pooler 가 가끔 첫 연결을 거부(28P01)하므로 몇 번 재시도한다.
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

initDbWithRetry()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`todo-app-db 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB 초기화 최종 실패:', err.message);
    process.exit(1);
  });

module.exports = server;
