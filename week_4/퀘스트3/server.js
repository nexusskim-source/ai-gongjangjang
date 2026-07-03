// 냉장고 재료 & 레시피 관리 앱 - 백엔드 서버
// 모든 데이터를 PostgreSQL(Supabase)에 저장한다. (pg 패키지 사용)

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const OpenAI = require('openai');

// OPENAI_API_KEY 환경변수를 자동으로 사용한다.
const openai = new OpenAI();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, 'index.html');

if (!process.env.DATABASE_URL) {
  console.error('환경변수 DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// Supabase 는 SSL 연결을 요구한다. 셀프사인 인증서이므로 rejectUnauthorized:false.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- DB 행(snake_case) -> 클라이언트 JSON(camelCase) ----------
function rowToIngredient(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category || '기타',
    quantity: r.quantity !== null && r.quantity !== undefined ? Number(r.quantity) : 0,
    unit: r.unit || '개',
    addedAt: r.added_at ? new Date(r.added_at).toISOString() : '',
  };
}

function rowToRecipe(r) {
  return {
    id: r.id,
    title: r.title,
    ingredients: r.ingredients || '',
    steps: r.steps || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

// ---------- 테이블 생성 ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fridge_ingredients (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      category  TEXT NOT NULL DEFAULT '기타',
      quantity  NUMERIC NOT NULL DEFAULT 1,
      unit      TEXT NOT NULL DEFAULT '개',
      added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      ingredients TEXT NOT NULL DEFAULT '',
      steps       TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
      res.end('<h1>냉장고 & 레시피 API 서버</h1><p>index.html 이 아직 준비되지 않았습니다.</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------- 재료 API ----------
async function handleIngredientList(res) {
  const { rows } = await pool.query('SELECT * FROM fridge_ingredients ORDER BY id ASC');
  sendJSON(res, 200, rows.map(rowToIngredient));
}

async function handleIngredientCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return sendJSON(res, 400, { error: '재료 이름(name)은 필수입니다.' });
  }
  const category =
    typeof body.category === 'string' && body.category.trim() ? body.category.trim() : '기타';
  const quantity =
    body.quantity !== undefined && body.quantity !== null && !isNaN(Number(body.quantity))
      ? Number(body.quantity)
      : 1;
  const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : '개';

  const { rows } = await pool.query(
    'INSERT INTO fridge_ingredients (name, category, quantity, unit) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, category, quantity, unit]
  );
  sendJSON(res, 201, rowToIngredient(rows[0]));
}

async function handleIngredientDelete(res, id) {
  const numId = Number(id);
  if (!numId) return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
  const { rows } = await pool.query(
    'DELETE FROM fridge_ingredients WHERE id = $1 RETURNING *',
    [numId]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 id의 재료를 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { deleted: rowToIngredient(rows[0]) });
}

// ---------- 레시피 API ----------
async function handleRecipeList(res) {
  const { rows } = await pool.query('SELECT * FROM recipes ORDER BY id ASC');
  sendJSON(res, 200, rows.map(rowToRecipe));
}

async function handleRecipeCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return sendJSON(res, 400, { error: '요리명(title)은 필수입니다.' });
  }
  const ingredients = typeof body.ingredients === 'string' ? body.ingredients.trim() : '';
  const steps = typeof body.steps === 'string' ? body.steps.trim() : '';

  const { rows } = await pool.query(
    'INSERT INTO recipes (title, ingredients, steps) VALUES ($1,$2,$3) RETURNING *',
    [title, ingredients, steps]
  );
  sendJSON(res, 201, rowToRecipe(rows[0]));
}

// ---------- AI 레시피 자동 생성 (Claude) ----------
// 냉장고 재료 전체를 조회해 Claude 에게 레시피 1개를 생성 요청한다.
// DB 에 저장하지 않고 { title, ingredients, steps } 만 반환한다.
async function handleRecipeGenerate(req, res) {
  // 선택적 body: { note }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: '잘못된 요청 형식입니다. (' + err.message + ')' });
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  // 1) 냉장고 재료 조회
  const { rows } = await pool.query('SELECT * FROM fridge_ingredients ORDER BY id ASC');

  // 2) 재료가 없으면 400
  if (rows.length === 0) {
    return sendJSON(res, 400, {
      error: '냉장고에 재료가 없습니다. 먼저 재료를 등록해 주세요.',
    });
  }

  // 3) 재료 목록을 텍스트로 정리 (이름 · 수량 · 단위 · 분류)
  const ingredientListText = rows
    .map((r) => {
      const ing = rowToIngredient(r);
      return `- ${ing.name} ${ing.quantity}${ing.unit} (분류: ${ing.category})`;
    })
    .join('\n');

  // 4) OpenAI 호출 (구조화 출력로 title/ingredients/steps 를 안정적으로 수신)
  let response;
  try {
    response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: 'system',
          content:
            '너는 한국 가정식 요리 전문가다. 주어진 냉장고 재료로 만들 수 있는 현실적인 레시피 1개를 제안한다. 재료는 있는 것 위주로 쓰되 소금·기름 등 기본 조미료는 있다고 가정한다. 반드시 한국어로 작성한다.',
        },
        {
          role: 'user',
          content: `다음 냉장고 재료로 만들 수 있는 요리를 하나 추천해줘.\n\n[냉장고 재료]\n${ingredientListText}\n\n${note ? '추가 요청: ' + note : ''}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'recipe',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '요리명' },
              ingredients: {
                type: 'string',
                description: '재료와 분량 목록(줄바꿈으로 구분)',
              },
              steps: {
                type: 'string',
                description: '조리 순서(번호 목록, 줄바꿈으로 구분)',
              },
            },
            required: ['title', 'ingredients', 'steps'],
            additionalProperties: false,
          },
        },
      },
    });
  } catch (err) {
    console.error('OpenAI API 호출 실패:', err);
    return sendJSON(res, 500, {
      error: 'AI 레시피 생성에 실패했습니다: ' + err.message,
    });
  }

  // 5) 응답 파싱: choices[0].message.content 는 구조화 출력 JSON 문자열
  try {
    const text = response.choices?.[0]?.message?.content || '';

    if (!text.trim()) {
      throw new Error('AI 응답에 텍스트 내용이 없습니다.');
    }

    const recipe = JSON.parse(text);
    if (!recipe.title || !recipe.ingredients || !recipe.steps) {
      throw new Error('AI 응답에 title/ingredients/steps 가 누락되었습니다.');
    }

    // DB 저장은 하지 않는다. 프론트가 POST /api/recipes 로 저장.
    return sendJSON(res, 200, {
      title: String(recipe.title),
      ingredients: String(recipe.ingredients),
      steps: String(recipe.steps),
    });
  } catch (err) {
    console.error('AI 응답 파싱 실패:', err);
    return sendJSON(res, 500, {
      error: 'AI 응답을 해석하지 못했습니다: ' + err.message,
    });
  }
}

async function handleRecipeDelete(res, id) {
  const numId = Number(id);
  if (!numId) return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
  const { rows } = await pool.query('DELETE FROM recipes WHERE id = $1 RETURNING *', [numId]);
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 id의 레시피를 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { deleted: rowToRecipe(rows[0]) });
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // 재료
    if (pathname === '/api/ingredients') {
      if (method === 'GET') return await handleIngredientList(res);
      if (method === 'POST') return await handleIngredientCreate(req, res);
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }
    const ingDelMatch = pathname.match(/^\/api\/ingredients\/([^/]+)$/);
    if (ingDelMatch) {
      if (method === 'DELETE') return await handleIngredientDelete(res, decodeURIComponent(ingDelMatch[1]));
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // AI 레시피 자동 생성 (반드시 /api/recipes 보다 먼저 매칭)
    if (pathname === '/api/recipes/generate') {
      if (method === 'POST') return await handleRecipeGenerate(req, res);
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // 레시피
    if (pathname === '/api/recipes') {
      if (method === 'GET') return await handleRecipeList(res);
      if (method === 'POST') return await handleRecipeCreate(req, res);
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }
    const recDelMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (recDelMatch) {
      if (method === 'DELETE') return await handleRecipeDelete(res, decodeURIComponent(recDelMatch[1]));
      return sendJSON(res, 405, { error: '허용되지 않은 메서드입니다.' });
    }

    // 정적 파일
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
// Supabase pooler 가 가끔 첫 연결을 거부(28P01)하므로 몇 번 재시도한다.
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

initDbWithRetry()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`냉장고 & 레시피 서버 실행 중 (Supabase 저장): http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB 초기화 최종 실패:', err.message);
    process.exit(1);
  });

module.exports = server;
