// ☕ Day On 카페 DB 조회 도구 (읽기 전용)
// 사용: node cafe-query.js "SELECT * FROM cafe_menus LIMIT 5"
//      node cafe-query.js --schema     (테이블/컬럼 목록)
//
// 안전장치: SELECT / WITH 로 시작하는 쿼리만 허용. 쓰기(INSERT/UPDATE/DELETE/DROP 등) 차단.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Client } = require('pg');

const SCHEMA_SQL = `
  SELECT table_name, ordinal_position, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name LIKE 'cafe_%'
  ORDER BY table_name, ordinal_position`;

const BLOCKED = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY)\b/i;

async function connect() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 15000,
  });
  // Supabase pooler 첫 연결 간헐 실패(28P01) → 재시도
  for (let i = 1; i <= 5; i++) {
    try { await c.connect(); return c; }
    catch (e) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

(async () => {
  const arg = process.argv.slice(2).join(' ').trim();
  if (!arg) {
    console.error('사용법: node cafe-query.js "SELECT ..."   또는   node cafe-query.js --schema');
    process.exit(1);
  }

  const client = await connect();

  // --schema : 테이블 구조 출력
  if (arg === '--schema') {
    const r = await client.query(SCHEMA_SQL);
    const byTable = {};
    for (const row of r.rows) {
      (byTable[row.table_name] ||= []).push(`${row.column_name} ${row.data_type}`);
    }
    for (const [t, cols] of Object.entries(byTable)) {
      console.log(`\n[${t}]`);
      cols.forEach((c) => console.log(`  - ${c}`));
    }
    await client.end();
    return;
  }

  const sql = arg.replace(/;+\s*$/, '');
  if (!/^\s*(SELECT|WITH)\b/i.test(sql) || BLOCKED.test(sql)) {
    console.error('❌ 조회(SELECT/WITH) 쿼리만 실행할 수 있습니다. 데이터 변경은 차단됩니다.');
    await client.end();
    process.exit(1);
  }

  try {
    const r = await client.query(sql);
    if (r.rows.length === 0) {
      console.log('(결과 없음)');
    } else {
      console.table(r.rows);
      console.log(`${r.rows.length}행`);
    }
  } catch (e) {
    console.error('❌ 쿼리 오류:', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
