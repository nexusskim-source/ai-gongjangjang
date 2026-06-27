// memo-app-db 백엔드 서버
// 메모를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

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
function rowToNote(r) {
  return {
    id: r.id,
    title: r.title || '',
    content: r.content || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 테이블 생성 + (비어있으면) 예시 메모 삽입
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      content    TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM notes');
  if (rows[0].c === 0) {
    const seed = [
      ['장보기 목록', '우유, 계란, 두부, 쌀국수\n주말 장보기 전에 냉장고 확인하기'],
      ['아이디어 메모', '메모장 앱 만들기 — DB 연동 버전\n다음엔 태그/검색 기능도 추가해보자'],
      ['읽을 책', '클린 코드 3장\n리팩터링 2판\nDDD 입문서'],
    ];
    for (const [title, content] of seed) {
      await pool.query('INSERT INTO notes (title, content) VALUES ($1, $2)', [title, content]);
    }
    console.log('예시 메모 3건을 DB에 삽입했습니다.');
  }
}

// 입력 정규화
function normalize({ title = '', content = '' }) {
  return {
    title: String(title).trim(),
    content: String(content),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5e6) req.destroy(); // 과도한 입력 방어 (메모는 길 수 있어 5MB)
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

// 제목/내용이 모두 비어있으면 저장 거부
function isEmptyNote(n) {
  return !n.title && !n.content.trim();
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  try {
    // 목록 (최근 수정순)
    if (req.method === 'GET' && url === '/api/notes') {
      const { rows } = await pool.query('SELECT * FROM notes ORDER BY updated_at DESC, id DESC');
      return sendJson(res, 200, rows.map(rowToNote));
    }

    // 추가
    if (req.method === 'POST' && url === '/api/notes') {
      const note = normalize(await readJsonBody(req));
      if (isEmptyNote(note)) {
        return sendJson(res, 400, { success: false, message: '제목이나 내용 중 하나는 입력해야 합니다.' });
      }
      const { rows } = await pool.query(
        'INSERT INTO notes (title, content) VALUES ($1, $2) RETURNING *',
        [note.title, note.content]
      );
      return sendJson(res, 201, { success: true, ...rowToNote(rows[0]) });
    }

    // 수정 (부분 수정: 전달된 필드만 갱신, updated_at 자동 갱신)
    if (req.method === 'PUT' && url === '/api/notes') {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      if (!id) return sendJson(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });

      const cur = await pool.query('SELECT * FROM notes WHERE id = $1', [id]);
      if (cur.rows.length === 0) {
        return sendJson(res, 404, { success: false, message: '해당 메모를 찾을 수 없습니다.' });
      }
      const prev = rowToNote(cur.rows[0]);
      const merged = normalize({
        title: body.title !== undefined ? body.title : prev.title,
        content: body.content !== undefined ? body.content : prev.content,
      });
      if (isEmptyNote(merged)) {
        return sendJson(res, 400, { success: false, message: '제목이나 내용 중 하나는 있어야 합니다.' });
      }
      const { rows } = await pool.query(
        'UPDATE notes SET title=$1, content=$2, updated_at=now() WHERE id=$3 RETURNING *',
        [merged.title, merged.content, id]
      );
      return sendJson(res, 200, { success: true, ...rowToNote(rows[0]) });
    }

    // 삭제
    if (req.method === 'DELETE' && url === '/api/notes') {
      const body = await readJsonBody(req);
      const id = Number(body.id);
      if (!id) return sendJson(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
      const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1', [id]);
      if (rowCount === 0) {
        return sendJson(res, 404, { success: false, message: '해당 메모를 찾을 수 없습니다.' });
      }
      return sendJson(res, 200, { success: true, id });
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
      console.log(`memo-app-db 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB 초기화 최종 실패:', err.message);
    process.exit(1);
  });

module.exports = server;
