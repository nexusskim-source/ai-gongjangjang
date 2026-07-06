// 가계부(household budget) 백엔드 서버 — 로컬 개발용 http 서버
// 데이터를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)
// 인증(로그인) 기능은 없다. 모든 거래는 공용이다.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const VALID_TYPES = ['income', 'expense'];

if (!process.env.DATABASE_URL) {
  console.error('환경변수 DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
// 환경변수에 trailing newline 이 끼는 경우가 있어 .trim() 적용.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// DB 행(snake_case) -> 클라이언트 JSON(camelCase)
// amount 는 BIGINT 라 문자열로 올 수 있으므로 Number() 로 변환한다.
function rowToTransaction(r) {
  return {
    id: r.id,
    type: r.type,
    date: r.date,
    amount: Number(r.amount),
    category: r.category,
    memo: r.memo || '',
  };
}

// 테이블 생성
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id         SERIAL PRIMARY KEY,
      type       TEXT NOT NULL,
      date       TEXT NOT NULL,
      amount     BIGINT NOT NULL,
      category   TEXT NOT NULL DEFAULT '기타',
      memo       TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// 입력 정규화 + 검증. 오류 시 { status, message } 를 가진 에러를 던진다.
function normalizeForInsert(body) {
  const type = String(body.type || '').trim();
  const date = String(body.date || '').trim();
  const amountRaw = body.amount;
  let category = String(body.category || '').trim();
  const memo = body.memo === undefined || body.memo === null ? '' : String(body.memo).trim();

  if (!VALID_TYPES.includes(type)) {
    throw httpError(400, "type 은 'income' 또는 'expense' 여야 합니다.");
  }
  if (!date) {
    throw httpError(400, 'date 는 필수입니다.');
  }
  const amount = Number(amountRaw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'amount 는 0보다 큰 정수여야 합니다.');
  }
  if (!category) category = '기타';

  return { type, date, amount, category, memo };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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
        reject(httpError(400, '잘못된 JSON 형식입니다.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// ---------- 공유 핸들러: 서버리스 함수와 동일한 SQL/로직 ----------

async function listTransactions() {
  const { rows } = await pool.query(
    'SELECT * FROM transactions ORDER BY date DESC, id DESC'
  );
  return rows.map(rowToTransaction);
}

async function createTransaction(body) {
  const t = normalizeForInsert(body);
  const { rows } = await pool.query(
    'INSERT INTO transactions (type, date, amount, category, memo) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [t.type, t.date, t.amount, t.category, t.memo]
  );
  return { success: true, ...rowToTransaction(rows[0]) };
}

async function deleteTransaction(body) {
  const id = Number(body.id);
  if (!id) throw httpError(400, '유효하지 않은 id 입니다.');
  const { rowCount } = await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
  if (rowCount === 0) throw httpError(404, '해당 거래를 찾을 수 없습니다.');
  return { success: true, id };
}

async function getSummary() {
  const totalsQ = pool.query(`
    SELECT type, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    GROUP BY type
  `);
  const byCatQ = pool.query(`
    SELECT type, category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    GROUP BY type, category
    ORDER BY total DESC
  `);
  const [totalsRes, byCatRes] = await Promise.all([totalsQ, byCatQ]);

  let income = 0;
  let expense = 0;
  for (const r of totalsRes.rows) {
    if (r.type === 'expense') expense = Number(r.total);
    else income += Number(r.total);
  }
  const byCategory = byCatRes.rows.map((r) => ({
    category: r.category,
    type: r.type,
    total: Number(r.total),
  }));

  return { income, expense, balance: income - expense, byCategory };
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  try {
    // ---------- 거래 API ----------
    if (url === '/api/transactions') {
      if (req.method === 'GET') {
        return sendJson(res, 200, await listTransactions());
      }
      if (req.method === 'POST') {
        return sendJson(res, 201, await createTransaction(await readJsonBody(req)));
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, await deleteTransaction(await readJsonBody(req)));
      }
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    }

    // ---------- 요약 API ----------
    if (url === '/api/summary') {
      if (req.method === 'GET') {
        return sendJson(res, 200, await getSummary());
      }
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
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
    const status = err.status || 500;
    if (status >= 500) console.error('요청 처리 오류:', err);
    sendJson(res, status, { success: false, message: err.message || '서버 오류' });
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
      console.log(`가계부 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB 초기화 최종 실패:', err.message);
    process.exit(1);
  });

module.exports = server;
