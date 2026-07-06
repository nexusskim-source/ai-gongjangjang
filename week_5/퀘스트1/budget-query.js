// 가계부 분석 에이전트용 읽기 전용 DB 조회 헬퍼.
// 사용: node budget-query.js "SELECT ... FROM transactions ..."
// 인자 없으면 전체 거래를 날짜순으로 덤프한다.
// 앱의 .env(DATABASE_URL)를 그대로 사용 → 서버(server.js) 실행 여부와 무관하게 동작.
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. 앱 폴더(week_5/퀘스트1)에서 실행하세요.');
  process.exit(1);
}

const sql = (process.argv[2] || 'SELECT id, type, date, amount, category, memo FROM transactions ORDER BY date').trim();

// 안전장치: 읽기 전용 SELECT 만 허용 (쓰기/DDL 차단, 다중 문장 차단)
const forbidden = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy)\b/i;
if (!/^select\b/i.test(sql) || forbidden.test(sql) || /;\s*\S/.test(sql)) {
  console.error('읽기 전용 단일 SELECT 쿼리만 허용됩니다.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const { rows } = await pool.query(sql);
    // amount 등 BIGINT는 pg가 문자열로 주지만, 숫자로 보기 좋게 변환해준다.
    const out = rows.map((r) => {
      const o = { ...r };
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'string' && /^-?\d+$/.test(o[k])) o[k] = Number(o[k]);
      }
      return o;
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('쿼리 오류:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
