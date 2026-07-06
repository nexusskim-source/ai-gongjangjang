// Vercel 서버리스 함수: /api/posts/:id (개별 글)
//  - GET    상세 1건
//  - PUT    수정 (본인 글만)
//  - DELETE 삭제 (본인 글만)
// 로컬은 server.js 로, 배포는 이 함수로 동작하며 동일한 SQL/로직을 공유한다.
const { Pool } = require('pg');
const auth = require('../../auth');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

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
      initPromise = null;
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

// 동적 라우트 파라미터: Vercel 은 req.query.id 로 제공한다. (안전하게 URL 폴백)
function getId(req) {
  if (req.query && req.query.id != null) return req.query.id;
  const pathname = (req.url || '').split('?')[0];
  const m = pathname.match(/\/api\/posts\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : '';
}

module.exports = async (req, res) => {
  try {
    await ensureDb();

    // 🔐 인증 필수
    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    const numId = Number(getId(req));
    if (!numId || !Number.isInteger(numId)) {
      return res.status(400).json({ success: false, message: '유효하지 않은 id 입니다.' });
    }

    // 상세
    if (req.method === 'GET') {
      const { rows } = await pool.query(
        `SELECT p.*, u.username AS author_name
           FROM community_posts p
           JOIN community_users u ON u.id = p.user_id
          WHERE p.id = $1`,
        [numId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: '해당 글을 찾을 수 없습니다.' });
      }
      return res.status(200).json(rowToPost(rows[0], user.id));
    }

    // 수정 (본인 글만)
    if (req.method === 'PUT') {
      const body = parseBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!title || !content) {
        return res.status(400).json({ success: false, message: '제목과 내용을 모두 입력해 주세요.' });
      }
      const cur = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [numId]);
      if (cur.rows.length === 0) {
        return res.status(404).json({ success: false, message: '해당 글을 찾을 수 없습니다.' });
      }
      if (Number(cur.rows[0].user_id) !== Number(user.id)) {
        return res.status(403).json({ success: false, message: '본인 글만 수정할 수 있습니다.' });
      }
      const { rows } = await pool.query(
        `UPDATE community_posts SET title = $1, content = $2, updated_at = now() WHERE id = $3 RETURNING *`,
        [title, content, numId]
      );
      const row = { ...rows[0], author_name: user.username };
      return res.status(200).json(rowToPost(row, user.id));
    }

    // 삭제 (본인 글만)
    if (req.method === 'DELETE') {
      const cur = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [numId]);
      if (cur.rows.length === 0) {
        return res.status(404).json({ success: false, message: '해당 글을 찾을 수 없습니다.' });
      }
      if (Number(cur.rows[0].user_id) !== Number(user.id)) {
        return res.status(403).json({ success: false, message: '본인 글만 삭제할 수 있습니다.' });
      }
      await pool.query('DELETE FROM community_posts WHERE id = $1', [numId]);
      return res.status(200).json({ success: true, id: numId });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('게시글 처리 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
