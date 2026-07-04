// 익명 월급/지출 통계 앱 - 백엔드 서버
// 모든 데이터는 개인 식별정보 없이 PostgreSQL(Supabase)에 익명 저장한다. (pg 사용)
// index.html 은 다른 에이전트가 생성하므로 여기서는 정적 서빙만 담당한다.
// 금액 단위: 만원.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'index.html');

if (!process.env.DATABASE_URL) {
  console.error('환경변수 DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
// 환경변수 끝에 붙는 개행 방지를 위해 .trim() 적용.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// 지출 카테고리 (DB 컬럼 <-> 응답 키 매핑용)
const EXPENSE_KEYS = ['food', 'housing', 'transport', 'subscription', 'etc'];

// 월급 히스토그램 구간(만원). max 가 null 이면 상한 없음.
const SALARY_BUCKETS = [
  { label: '~200', min: 0, max: 199 },
  { label: '200~299', min: 200, max: 299 },
  { label: '300~399', min: 300, max: 399 },
  { label: '400~499', min: 400, max: 499 },
  { label: '500~599', min: 500, max: 599 },
  { label: '600+', min: 600, max: null },
];

// ---------- 숫자 파싱 헬퍼 ----------
// 값이 없거나(undefined/null/'') 기본값(fallback) 사용. 숫자로 못 바꾸면 null 반환(=검증 실패 신호).
function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

// ---------- DB 행(snake_case) -> 클라이언트 JSON(camelCase) ----------
function rowToSubmission(r) {
  const expenses = {
    food: Number(r.exp_food) || 0,
    housing: Number(r.exp_housing) || 0,
    transport: Number(r.exp_transport) || 0,
    subscription: Number(r.exp_subscription) || 0,
    etc: Number(r.exp_etc) || 0,
  };
  const totalExpense =
    expenses.food + expenses.housing + expenses.transport + expenses.subscription + expenses.etc;
  return {
    id: r.id,
    salary: Number(r.salary) || 0,
    jobCategory: r.job_category || '기타',
    years: Number(r.years) || 0,
    expenses,
    totalExpense,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

// ---------- 테이블 생성 ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id               SERIAL PRIMARY KEY,
      salary           INTEGER NOT NULL,
      job_category     TEXT NOT NULL DEFAULT '기타',
      years            INTEGER NOT NULL DEFAULT 0,
      exp_food         INTEGER NOT NULL DEFAULT 0,
      exp_housing      INTEGER NOT NULL DEFAULT 0,
      exp_transport    INTEGER NOT NULL DEFAULT 0,
      exp_subscription INTEGER NOT NULL DEFAULT 0,
      exp_etc          INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// ---------- 응답/요청 헬퍼 ----------
function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(INDEX_FILE, (err, content) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>익명 월급/지출 통계 API 서버</h1><p>index.html 이 아직 준비되지 않았습니다.</p>'
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------- 통계 집계 ----------
// jobCategory 가 주어지면 해당 직군만, 아니면 전체. count 0 이면 안전한 빈 통계 반환.
async function computeStats(jobCategory) {
  const params = [];
  let where = '';
  if (jobCategory) {
    params.push(jobCategory);
    where = 'WHERE job_category = $1';
  }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int                                       AS count,
       COALESCE(AVG(salary), 0)                            AS avg_salary,
       COALESCE(AVG(exp_food), 0)                          AS avg_food,
       COALESCE(AVG(exp_housing), 0)                       AS avg_housing,
       COALESCE(AVG(exp_transport), 0)                     AS avg_transport,
       COALESCE(AVG(exp_subscription), 0)                  AS avg_subscription,
       COALESCE(AVG(exp_etc), 0)                           AS avg_etc,
       COALESCE(AVG(exp_food + exp_housing + exp_transport
                    + exp_subscription + exp_etc), 0)      AS avg_total_expense
     FROM submissions
     ${where}`,
    params
  );
  const agg = rows[0];
  const count = Number(agg.count) || 0;

  const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

  if (count === 0) {
    return {
      count: 0,
      avgSalary: 0,
      salaryDistribution: SALARY_BUCKETS.map((b) => ({
        label: b.label,
        min: b.min,
        max: b.max,
        count: 0,
      })),
      categoryAverages: { food: 0, housing: 0, transport: 0, subscription: 0, etc: 0 },
      avgTotalExpense: 0,
    };
  }

  // 히스토그램: CASE 로 각 구간 인원수 집계
  const { rows: distRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE salary < 200)                       AS b0,
       COUNT(*) FILTER (WHERE salary BETWEEN 200 AND 299)         AS b1,
       COUNT(*) FILTER (WHERE salary BETWEEN 300 AND 399)         AS b2,
       COUNT(*) FILTER (WHERE salary BETWEEN 400 AND 499)         AS b3,
       COUNT(*) FILTER (WHERE salary BETWEEN 500 AND 599)         AS b4,
       COUNT(*) FILTER (WHERE salary >= 600)                      AS b5
     FROM submissions
     ${where}`,
    params
  );
  const d = distRows[0];
  const counts = [d.b0, d.b1, d.b2, d.b3, d.b4, d.b5].map((x) => Number(x) || 0);
  const salaryDistribution = SALARY_BUCKETS.map((b, i) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: counts[i],
  }));

  return {
    count,
    avgSalary: round1(agg.avg_salary),
    salaryDistribution,
    categoryAverages: {
      food: round1(agg.avg_food),
      housing: round1(agg.avg_housing),
      transport: round1(agg.avg_transport),
      subscription: round1(agg.avg_subscription),
      etc: round1(agg.avg_etc),
    },
    avgTotalExpense: round1(agg.avg_total_expense),
  };
}

// 내 월급의 상위 퍼센트: (나보다 salary 큰 제출 수 / 전체) * 100, 반올림.
async function computeMyTopPercent(salary) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int                               AS total,
       COUNT(*) FILTER (WHERE salary > $1)::int     AS higher
     FROM submissions`,
    [salary]
  );
  const total = Number(rows[0].total) || 0;
  const higher = Number(rows[0].higher) || 0;
  if (total === 0) return 0;
  return Math.round((higher / total) * 100);
}

// ---------- API 핸들러 ----------
// POST /api/submissions
async function handleSubmissionCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }

  // salary: 필수, 숫자, >= 0
  const salary = toInt(body.salary, null);
  if (salary === null || salary < 0) {
    return sendJSON(res, 400, { error: '월급(salary)은 0 이상의 숫자로 필수 입력입니다.' });
  }

  const jobCategory =
    typeof body.jobCategory === 'string' && body.jobCategory.trim()
      ? body.jobCategory.trim()
      : '기타';

  const years = toInt(body.years, 0);
  if (years === null || years < 0) {
    return sendJSON(res, 400, { error: '연차(years)는 0 이상의 숫자여야 합니다.' });
  }

  const exp = body.expenses && typeof body.expenses === 'object' ? body.expenses : {};
  const parsed = {};
  for (const key of EXPENSE_KEYS) {
    const v = toInt(exp[key], 0);
    if (v === null || v < 0) {
      return sendJSON(res, 400, { error: `지출 항목(${key})은 0 이상의 숫자여야 합니다.` });
    }
    parsed[key] = v;
  }

  const { rows } = await pool.query(
    `INSERT INTO submissions
       (salary, job_category, years, exp_food, exp_housing, exp_transport, exp_subscription, exp_etc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      salary,
      jobCategory,
      years,
      parsed.food,
      parsed.housing,
      parsed.transport,
      parsed.subscription,
      parsed.etc,
    ]
  );

  const submission = rowToSubmission(rows[0]);
  const myTopPercent = await computeMyTopPercent(salary);
  const stats = await computeStats(null);

  sendJSON(res, 201, { submission, myTopPercent, stats });
}

// GET /api/stats  (?jobCategory=개발)
async function handleStats(res, parsedUrl) {
  const raw = parsedUrl.searchParams.get('jobCategory');
  const jobCategory = raw && raw.trim() ? raw.trim() : null;
  const stats = await computeStats(jobCategory);
  sendJSON(res, 200, stats);
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    if (pathname === '/api/submissions') {
      if (method === 'POST') return await handleSubmissionCreate(req, res);
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    if (pathname === '/api/stats') {
      if (method === 'GET') return await handleStats(res, parsedUrl);
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // 정적 파일 (index.html)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveIndex(res);
    }

    sendJSON(res, 404, { error: '페이지를 찾을 수 없습니다.' });
  } catch (err) {
    console.error('서버 오류:', err);
    sendJSON(res, 500, { error: '서버 내부 오류가 발생했습니다: ' + err.message });
  }
});

// ---------- 서버 시작 ----------
// Supabase pooler 가 가끔 첫 연결을 28P01 로 거부하므로 몇 번 재시도한다.
async function initDbWithRetry(retries = 4, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await initDb();
      return;
    } catch (err) {
      console.warn(`DB 초기화 시도 ${attempt}/${retries} 실패: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// 로컬 실행 시에만 서버 시작. (require 시에는 server export 만)
if (require.main === module) {
  initDbWithRetry()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`익명 월급/지출 통계 서버 실행 중 (Supabase 저장): http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('DB 초기화 최종 실패:', err.message);
      process.exit(1);
    });
}

module.exports = server;
