// Vercel 서버리스 함수: /api/posts (컬렉션)
//  - GET  목록 (최신순, author_name/mine 포함)
//  - POST 작성 (현재 로그인 사용자가 작성자)
// 로컬은 server.js 로, 배포는 이 함수로 동작하며 동일한 SQL/로직을 공유한다.
const { Pool } = require('pg');
const auth = require('../auth');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// DB 행(snake_case) -> 클라이언트 JSON(camelCase)
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

// 테이블 생성. 콜드스타트마다 매번 돌지 않도록 첫 호출의 프로미스를 캐싱한다.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await auth.ensureAuthSchema(pool); // community_users
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
    })().catch((err) => {
      initPromise = null; // 실패 시 다음 호출에서 재시도
      throw err;
    });
  }
  return initPromise;
}

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

    // 🔐 인증 필수
    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    // 목록 (최신순)
    if (req.method === 'GET') {
      const { rows } = await pool.query(
        `SELECT p.*, u.username AS author_name
           FROM community_posts p
           JOIN community_users u ON u.id = p.user_id
          ORDER BY p.created_at DESC`
      );
      return res.status(200).json(rows.map((r) => rowToPost(r, user.id)));
    }

    // 작성
    if (req.method === 'POST') {
      const body = parseBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!title || !content) {
        return res.status(400).json({ success: false, message: '제목과 내용을 모두 입력해 주세요.' });
      }
      const { rows } = await pool.query(
        `INSERT INTO community_posts (user_id, title, content) VALUES ($1, $2, $3) RETURNING *`,
        [user.id, title, content]
      );
      const row = { ...rows[0], author_name: user.username };
      return res.status(201).json(rowToPost(row, user.id));
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('게시글 처리 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
