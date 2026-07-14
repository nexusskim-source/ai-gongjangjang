// Vercel 서버리스 함수: /api/admin/todos (사장님 할 일 체크리스트)
//  - GET    목록
//  - POST   추가 { content }
//  - PUT    완료/미완료 토글 { id }
//  - DELETE 삭제 { id }
// 사장님(admin) 전용. 저장은 shop_admin_todos 테이블.
const { Pool } = require('pg');
const auth = require('../../auth');
const admin = require('../../admin');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw admin.httpError(400, '잘못된 JSON 형식입니다.');
    }
  }
  return req.body;
}

module.exports = async (req, res) => {
  try {
    const user = auth.getUserFromReq(req);
    await admin.requireAdmin(pool, user);
    await admin.ensureAdminSchema(pool);

    if (req.method === 'GET') return res.status(200).json(await admin.listTodos(pool));

    const body = parseBody(req);
    if (req.method === 'POST') return res.status(201).json(await admin.addTodo(pool, body));
    if (req.method === 'PUT') return res.status(200).json(await admin.toggleTodo(pool, body));
    if (req.method === 'DELETE') return res.status(200).json(await admin.removeTodo(pool, body));

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('할 일 처리 오류:', err);
    return res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
