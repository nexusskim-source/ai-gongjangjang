// Vercel 서버리스 함수: /api/todos
// 로컬은 server.js(http 서버)로, 배포는 이 함수로 동작한다.
// 할 일을 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)

const { Pool } = require('pg');

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

      const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM todos');
      if (rows[0].c === 0) {
        const seed = [
          ['장보기', '2026-06-30', '진행 전', '우유, 계란, 두부,쌀국수 사기'],
          ['운동하기', '2026-06-28', '진행 중', '헬스장 30분 유산소'],
          ['보고서 작성', '2026-06-29', '진행 전', '4주차 실습 정리 문서'],
          ['책 읽기', '2026-07-05', '진행 전', '클린 코드 3장까지'],
          ['친구 약속', '2026-06-27', '완료', '저녁 7시 강남역'],
        ];
        for (const [title, due, status, memo] of seed) {
          await pool.query(
            'INSERT INTO todos (title, due_date, status, memo) VALUES ($1, $2, $3, $4)',
            [title, due, status, memo]
          );
        }
      }
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

    // 목록
    if (req.method === 'GET') {
      const { rows } = await pool.query('SELECT * FROM todos ORDER BY id ASC');
      return res.status(200).json(rows.map(rowToTodo));
    }

    // 추가
    if (req.method === 'POST') {
      const todo = normalize(parseBody(req));
      if (!todo.title) return res.status(400).json({ success: false, message: '제목은 필수입니다.' });
      const { rows } = await pool.query(
        'INSERT INTO todos (title, due_date, status, memo) VALUES ($1,$2,$3,$4) RETURNING *',
        [todo.title, todo.dueDate, todo.status, todo.memo]
      );
      return res.status(201).json({ success: true, ...rowToTodo(rows[0]) });
    }

    // 수정 (부분 수정: 전달된 필드만 갱신)
    if (req.method === 'PUT') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });

      const cur = await pool.query('SELECT * FROM todos WHERE id = $1', [id]);
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
        'UPDATE todos SET title=$1, due_date=$2, status=$3, memo=$4 WHERE id=$5 RETURNING *',
        [merged.title, merged.dueDate, merged.status, merged.memo, id]
      );
      return res.status(200).json({ success: true, ...rowToTodo(rows[0]) });
    }

    // 삭제
    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });
      const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1', [id]);
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
