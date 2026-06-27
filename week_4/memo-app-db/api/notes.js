// Vercel 서버리스 함수: /api/notes
// 로컬은 server.js(http 서버)로, 배포는 이 함수로 동작한다.
// 메모를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

// 서버리스에서는 인스턴스가 재사용(warm)되므로 풀을 모듈 스코프에 한 번만 만든다.
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

// 테이블 생성 + (비어있으면) 예시 메모 삽입.
// 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
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
function normalize({ title = '', content = '' }) {
  return {
    title: String(title).trim(),
    content: String(content),
  };
}

// 제목/내용이 모두 비어있으면 저장 거부
function isEmptyNote(n) {
  return !n.title && !n.content.trim();
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

    // 목록 (최근 수정순)
    if (req.method === 'GET') {
      const { rows } = await pool.query('SELECT * FROM notes ORDER BY updated_at DESC, id DESC');
      return res.status(200).json(rows.map(rowToNote));
    }

    // 추가
    if (req.method === 'POST') {
      const note = normalize(parseBody(req));
      if (isEmptyNote(note)) {
        return res.status(400).json({ success: false, message: '제목이나 내용 중 하나는 입력해야 합니다.' });
      }
      const { rows } = await pool.query(
        'INSERT INTO notes (title, content) VALUES ($1, $2) RETURNING *',
        [note.title, note.content]
      );
      return res.status(201).json({ success: true, ...rowToNote(rows[0]) });
    }

    // 수정 (부분 수정: 전달된 필드만 갱신, updated_at 자동 갱신)
    if (req.method === 'PUT') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });

      const cur = await pool.query('SELECT * FROM notes WHERE id = $1', [id]);
      if (cur.rows.length === 0) {
        return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
      }
      const prev = rowToNote(cur.rows[0]);
      const merged = normalize({
        title: body.title !== undefined ? body.title : prev.title,
        content: body.content !== undefined ? body.content : prev.content,
      });
      if (isEmptyNote(merged)) {
        return res.status(400).json({ success: false, message: '제목이나 내용 중 하나는 있어야 합니다.' });
      }
      const { rows } = await pool.query(
        'UPDATE notes SET title=$1, content=$2, updated_at=now() WHERE id=$3 RETURNING *',
        [merged.title, merged.content, id]
      );
      return res.status(200).json({ success: true, ...rowToNote(rows[0]) });
    }

    // 삭제
    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const id = Number(body.id);
      if (!id) return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });
      const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1', [id]);
      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
      }
      return res.status(200).json({ success: true, id });
    }

    res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('요청 처리 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
