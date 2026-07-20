// 스키마 + RLS + Storage 정책을 Supabase(Postgres)에 적용한다.
// 사용법: node setup-db.js "<DB_PASSWORD>"
const path = require('path');
const fs = require('fs');
const { Client } = require(path.join('C:', '수경_ai공장장', 'week_5', '퀘스트3', 'node_modules', 'pg'));

const REF = 'fqkxikhfzpyhhdhnyxhq';
const HOST = 'aws-1-ap-southeast-1.pooler.supabase.com';
const PW = process.argv[2] || process.env.DB_PW;
if (!PW) { console.error('비밀번호를 인자로 주세요: node setup-db.js "<PW>"'); process.exit(1); }

const DATABASE_URL = `postgresql://postgres.${REF}:${encodeURIComponent(PW)}@${HOST}:6543/postgres`;
const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

async function once() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  await client.connect();
  await client.query(sql);
  await client.end();
}
(async () => {
  for (let i = 1; i <= 5; i++) {
    try { await once(); console.log('✅ 스키마/RLS/Storage 적용 완료'); return; }
    catch (e) {
      console.log(`시도 ${i} 실패: ${e.code || ''} ${e.message}`);
      if (i === 5) { console.error('최종 실패'); process.exit(1); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
})();
