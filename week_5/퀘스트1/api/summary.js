// Vercel 서버리스 함수: /api/summary
// 카테고리별 합계 및 수입/지출/잔액 요약을 반환한다.
// 로컬은 server.js(http 서버)의 getSummary 로직과 동일하다. 인증 기능 없음.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('환경변수 DATABASE_URL 이 설정되지 않았습니다. (Vercel 프로젝트 환경변수 확인)');
}

// 서버리스에서는 인스턴스가 재사용(warm)되므로 풀을 모듈 스코프에 한 번만 만든다.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

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
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();

    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

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

    return res.status(200).json({
      income,
      expense,
      balance: income - expense,
      byCategory,
    });
  } catch (err) {
    console.error('요약 처리 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
};
