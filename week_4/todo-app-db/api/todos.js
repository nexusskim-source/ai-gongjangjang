// Vercel 서버리스 함수: /api/todos
// 로컬은 server.js(http 서버)로, 배포는 이 함수로 동작한다.
// 할 일을 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)

const { Pool } = require('pg');
const auth = require('../auth');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const VALID_STATUS = ['진행 전', '진행 중', '완료'];

// 서버리스에서는 인스턴스가 재사용(warm)되므로 풀을 모듈 스코프에 한 번만 만든다.
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

// 테이블 생성 + (비어있으면) 초기 데이터 삽입.
// 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
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
    })().catch((err) => {
      // 실패 시 다음 호출에서 다시 시도할 수 있도록 캐시를 비운다.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
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

// Vercel 은 JSON 본문을 req.body 로 파싱해준다. (문자열로 올 경우 대비)
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('잘못된 JSON 형식입니다.');
    }
  }
  return req.body;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();

    // 🔐 인증 필수: 유효한 JWT 가 없으면 401
    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    // 목록 (본인 것만)
    if (req.method === 'GET') {
      const { rows } = await pool.query(
        'SELECT * FROM todos WHERE user_id = $1 ORDER BY id ASC',
        [user.id]
      );
      return res.status(200).json(rows.map(rowToTodo));
    }

    // 추가 (본인 소유로)
    if (req.method === 'POST') {
      const todo = normalize(parseBody(req));
      if (!todo.title) return res.status(400).json({ success: false, message: '제목은 필수입니다.' });
      const { rows } = await pool.query(
        'INSERT INTO todos (title, due_date, status, memo, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [todo.title, todo.dueDate, todo.status, todo.memo, user.id]
      );
      return res.status(201).json({ success: true, ...rowToTodo(rows[0]) });
    }

    // 수정 (본인 것만, 부분 수정)
    if (req.method === 'PUT') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });

      const cur = await pool.query('SELECT * FROM todos WHERE id = $1 AND user_id = $2', [id, user.id]);
      if (cur.rows.length === 0) {
        return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
      }
      const prev = rowToTodo(cur.rows[0]);
      const merged = normalize({
        title: body.title !== undefined ? body.title : prev.title,
        dueDate: body.dueDate !== undefined ? body.dueDate : prev.dueDate,
        status: body.status !== undefined ? body.status : prev.status,
        memo: body.memo !== undefined ? body.memo : prev.memo,
      });
      if (!merged.title) return res.status(400).json({ success: false, message: '제목은 비울 수 없습니다.' });

      const { rows } = await pool.query(
        'UPDATE todos SET title=$1, due_date=$2, status=$3, memo=$4 WHERE id=$5 AND user_id=$6 RETURNING *',
        [merged.title, merged.dueDate, merged.status, merged.memo, id, user.id]
      );
      return res.status(200).json({ success: true, ...rowToTodo(rows[0]) });
    }

    // 삭제 (본인 것만)
    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });
      const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1 AND user_id = $2', [id, user.id]);
      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
      }
      return res.status(200).json({ success: true, id });
    }

    res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('요청 처리 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
