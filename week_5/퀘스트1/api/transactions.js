// Vercel 서버리스 함수: /api/transactions
// 로컬은 server.js(http 서버)로, 배포는 이 함수로 동작한다.
// 가계부 거래를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)
// 인증 기능 없음 — 모든 거래는 공용이다.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const VALID_TYPES = ['income', 'expense'];

// 서버리스에서는 인스턴스가 재사용(warm)되므로 풀을 모듈 스코프에 한 번만 만든다.
// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// DB 행(snake_case) -> 클라이언트 JSON(camelCase). amount 는 BIGINT 라 Number() 처리.
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

// 테이블 생성. 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
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
    })().catch((err) => {
      // 실패 시 다음 호출에서 다시 시도할 수 있도록 캐시를 비운다.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 입력 정규화 + 검증
function normalizeForInsert(body) {
  const type = String(body.type || '').trim();
  const date = String(body.date || '').trim();
  let category = String(body.category || '').trim();
  const memo = body.memo === undefined || body.memo === null ? '' : String(body.memo).trim();

  if (!VALID_TYPES.includes(type)) {
    throw httpError(400, "type 은 'income' 또는 'expense' 여야 합니다.");
  }
  if (!date) {
    throw httpError(400, 'date 는 필수입니다.');
  }
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'amount 는 0보다 큰 정수여야 합니다.');
  }
  if (!category) category = '기타';

  return { type, date, amount, category, memo };
}

// Vercel 은 JSON 본문을 req.body 로 파싱해준다. (문자열로 올 경우 대비)
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw httpError(400, '잘못된 JSON 형식입니다.');
    }
  }
  return req.body;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();

    // 목록
    if (req.method === 'GET') {
      const { rows } = await pool.query(
        'SELECT * FROM transactions ORDER BY date DESC, id DESC'
      );
      return res.status(200).json(rows.map(rowToTransaction));
    }

    // 추가
    if (req.method === 'POST') {
      const t = normalizeForInsert(parseBody(req));
      const { rows } = await pool.query(
        'INSERT INTO transactions (type, date, amount, category, memo) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [t.type, t.date, t.amount, t.category, t.memo]
      );
      return res.status(201).json({ success: true, ...rowToTransaction(rows[0]) });
    }

    // 삭제
    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });
      const { rowCount } = await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: '해당 거래를 찾을 수 없습니다.' });
      }
      return res.status(200).json({ success: true, id });
    }

    res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('요청 처리 오류:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
