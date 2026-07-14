// 사장님 전용 대시보드 공용 모듈 (로컬 server.js + Vercel api/admin/*.js 에서 함께 사용)
//  - 접근 권한: shop_users.username === 'admin' 인 사용자만.
//  - 데이터 출처: 카페 운영 DB (cafe_* 테이블, week_5/퀘스트6 에서 적재한 90일치)
//  - 할 일 체크리스트만 이 앱 전용 테이블(shop_admin_todos)에 저장한다.
const ADMIN_USERNAME = 'admin';

const CAFE_NAME = 'Day On (데이온)';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 토큰의 uid 로 DB 를 다시 확인한다. (토큰 payload 만 믿지 않는다)
async function requireAdmin(pool, user) {
  if (!user) throw httpError(401, '로그인이 필요합니다.');
  const { rows } = await pool.query('SELECT username FROM shop_users WHERE id = $1', [user.id]);
  if (rows.length === 0 || rows[0].username !== ADMIN_USERNAME) {
    throw httpError(403, '사장님(admin) 계정만 접근할 수 있는 페이지입니다.');
  }
  return true;
}

// ---------- 할 일 테이블 ----------
const SEED_TODOS = ['우유 발주 넣기', '알바 면접 (오후 3시)', '원두 입고 확인'];

async function ensureAdminSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_admin_todos (
      id         SERIAL PRIMARY KEY,
      content    TEXT NOT NULL,
      done       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM shop_admin_todos');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO shop_admin_todos (content, done) VALUES ($1,false),($2,false),($3,true)`,
      SEED_TODOS
    );
  }
}

async function listTodos(pool) {
  const { rows } = await pool.query(
    'SELECT id, content, done FROM shop_admin_todos ORDER BY done ASC, id ASC'
  );
  return rows.map((r) => ({ id: r.id, content: r.content, done: r.done }));
}

async function addTodo(pool, body) {
  const content = String((body && body.content) || '').trim();
  if (!content) throw httpError(400, '할 일 내용을 입력해 주세요.');
  if (content.length > 120) throw httpError(400, '할 일은 120자 이내로 입력해 주세요.');
  await pool.query('INSERT INTO shop_admin_todos (content) VALUES ($1)', [content]);
  return listTodos(pool);
}

async function toggleTodo(pool, body) {
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'id 가 올바르지 않습니다.');
  const { rowCount } = await pool.query('UPDATE shop_admin_todos SET done = NOT done WHERE id = $1', [id]);
  if (rowCount === 0) throw httpError(404, '할 일을 찾을 수 없습니다.');
  return listTodos(pool);
}

async function removeTodo(pool, body) {
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'id 가 올바르지 않습니다.');
  await pool.query('DELETE FROM shop_admin_todos WHERE id = $1', [id]);
  return listTodos(pool);
}

// ---------- 대시보드 집계 (cafe_* 테이블) ----------
// DATE 컬럼은 to_char 로 문자열화해서 넘긴다. (JS Date 변환 시 타임존이 하루 밀리는 걸 방지)

// 데이터가 있는 가장 최근 영업일 = 대시보드의 기준일
async function getLatestDate(pool) {
  const { rows } = await pool.query(
    `SELECT to_char(MAX(sale_date), 'YYYY-MM-DD') AS d FROM cafe_daily_sales WHERE is_closed = false`
  );
  if (!rows[0] || !rows[0].d) throw httpError(500, '카페 매출 데이터가 없습니다. (cafe_daily_sales 비어 있음)');
  return rows[0].d;
}

// 기준일 하루 실적 + 직전 영업일 대비 증감
async function getLatestDay(pool, latestDate) {
  const { rows } = await pool.query(
    `SELECT to_char(sale_date,'YYYY-MM-DD') AS date, weekday, visitors, order_count, revenue, weather
       FROM cafe_daily_sales
      WHERE is_closed = false AND sale_date <= $1
      ORDER BY sale_date DESC
      LIMIT 2`,
    [latestDate]
  );
  const cur = rows[0];
  const prev = rows[1];
  const revenue = Number(cur.revenue);
  const prevRevenue = prev ? Number(prev.revenue) : 0;
  return {
    date: cur.date,
    weekday: cur.weekday,
    weather: cur.weather || '',
    revenue,
    visitors: Number(cur.visitors),
    orderCount: Number(cur.order_count),
    avgTicket: Number(cur.order_count) ? Math.round(revenue / Number(cur.order_count)) : 0,
    prevRevenue,
    changePct: prevRevenue ? Math.round(((revenue - prevRevenue) / prevRevenue) * 1000) / 10 : null,
  };
}

// 기준일이 속한 주(월~일)의 일별 매출 + 지난주 합계 대비
async function getWeekSales(pool, latestDate) {
  const { rows } = await pool.query(
    `WITH base AS (SELECT date_trunc('week', $1::date)::date AS wk_start)
     SELECT to_char(s.sale_date,'YYYY-MM-DD') AS date,
            s.weekday, s.revenue, s.visitors, s.is_closed
       FROM cafe_daily_sales s, base b
      WHERE s.sale_date >= b.wk_start AND s.sale_date < b.wk_start + 7
      ORDER BY s.sale_date ASC`,
    [latestDate]
  );
  const prevQ = await pool.query(
    `WITH base AS (SELECT date_trunc('week', $1::date)::date AS wk_start)
     SELECT COALESCE(SUM(s.revenue),0)::bigint AS total
       FROM cafe_daily_sales s, base b
      WHERE s.sale_date >= b.wk_start - 7 AND s.sale_date < b.wk_start`,
    [latestDate]
  );
  const days = rows.map((r) => ({
    date: r.date,
    weekday: r.weekday,
    revenue: Number(r.revenue),
    visitors: Number(r.visitors),
    isClosed: r.is_closed,
  }));
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const prevTotal = Number(prevQ.rows[0].total);
  return {
    days,
    total,
    prevTotal,
    changePct: prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null,
    from: days.length ? days[0].date : latestDate,
    to: days.length ? days[days.length - 1].date : latestDate,
  };
}

// 최근 7일 판매량 기준 인기 메뉴 TOP3
async function getTopMenus(pool, latestDate, limit = 3) {
  const { rows } = await pool.query(
    `SELECT m.name, m.category, m.price,
            SUM(ms.qty)::int    AS qty,
            SUM(ms.amount)::int AS amount
       FROM cafe_menu_sales ms
       JOIN cafe_menus m ON m.id = ms.menu_id
      WHERE ms.sale_date > $1::date - 7 AND ms.sale_date <= $1::date
      GROUP BY m.id, m.name, m.category, m.price
      ORDER BY qty DESC
      LIMIT $2`,
    [latestDate, limit]
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    name: r.name,
    category: r.category,
    qty: Number(r.qty),
    amount: Number(r.amount),
  }));
}

// 최근 30일 리뷰 (평균 별점 + 최근 3건)
async function getReviews(pool, latestDate) {
  const avg = await pool.query(
    `SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS cnt
       FROM cafe_reviews
      WHERE review_date > $1::date - 30 AND review_date <= $1::date`,
    [latestDate]
  );
  const recent = await pool.query(
    `SELECT to_char(review_date,'YYYY-MM-DD') AS date, source, author, rating, menu, content
       FROM cafe_reviews
      WHERE review_date <= $1::date
      ORDER BY review_date DESC, id DESC
      LIMIT 3`,
    [latestDate]
  );
  return {
    avgRating: avg.rows[0].avg_rating ? Number(avg.rows[0].avg_rating) : null,
    count: Number(avg.rows[0].cnt),
    recent: recent.rows.map((r) => ({
      date: r.date,
      source: r.source,
      author: r.author,
      rating: Number(r.rating),
      menu: r.menu || '',
      content: r.content,
    })),
  };
}

// 안전재고 이하 = 발주 필요 품목
async function getRestockItems(pool) {
  const { rows } = await pool.query(
    `SELECT item_name, unit, current_stock, safety_stock, supplier
       FROM cafe_inventory
      WHERE current_stock <= safety_stock
      ORDER BY (current_stock / NULLIF(safety_stock,0)) ASC`
  );
  return rows.map((r) => ({
    itemName: r.item_name,
    unit: r.unit,
    currentStock: Number(r.current_stock),
    safetyStock: Number(r.safety_stock),
    supplier: r.supplier,
  }));
}

// 날씨별 평균 매출 (브리핑에서 "비 오면 매출 어떻더라" 를 근거로 말하기 위함)
async function getWeatherImpact(pool) {
  const { rows } = await pool.query(
    `SELECT weather, COUNT(*)::int AS days, ROUND(AVG(revenue))::int AS avg_revenue
       FROM cafe_daily_sales
      WHERE is_closed = false AND weather IS NOT NULL
      GROUP BY weather
      ORDER BY avg_revenue DESC`
  );
  return rows.map((r) => ({ weather: r.weather, days: Number(r.days), avgRevenue: Number(r.avg_revenue) }));
}

// 대시보드 한 방 조회 (위젯 4개가 쓰는 데이터)
async function getDashboard(pool) {
  await ensureAdminSchema(pool);
  const latestDate = await getLatestDate(pool);
  const [latestDay, week, topMenus, reviews, restock, todos] = await Promise.all([
    getLatestDay(pool, latestDate),
    getWeekSales(pool, latestDate),
    getTopMenus(pool, latestDate),
    getReviews(pool, latestDate),
    getRestockItems(pool),
    listTodos(pool),
  ]);
  return { cafeName: CAFE_NAME, latestDate, latestDay, week, topMenus, reviews, restock, todos };
}

// ---------- 오늘의 날씨 예보 (Open-Meteo, 키 불필요) ----------
// 카페 위치: 서울 연희동. 실패해도 브리핑은 진행한다.
async function getTodayForecast() {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=37.5686&longitude=126.9282' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=Asia%2FSeoul&forecast_days=1';
  const WMO = {
    0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림',
    45: '안개', 48: '안개', 51: '이슬비', 53: '이슬비', 55: '이슬비',
    61: '비', 63: '비', 65: '강한 비', 71: '눈', 73: '눈', 75: '강한 눈',
    80: '소나기', 81: '소나기', 82: '강한 소나기', 95: '뇌우', 96: '뇌우', 99: '뇌우',
  };
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const d = j.daily;
    if (!d || !d.time || !d.time.length) return null;
    return {
      date: d.time[0],
      summary: WMO[d.weather_code[0]] || '알 수 없음',
      tempMax: d.temperature_2m_max[0],
      tempMin: d.temperature_2m_min[0],
      rainChance: d.precipitation_probability_max[0],
    };
  } catch {
    return null; // 예보 실패는 치명적이지 않다
  }
}

// ---------- AI 브리핑 ----------
// 카페 DB(매출/메뉴/리뷰/재고) + 오늘 날씨 예보를 한데 모아 OpenAI 에 넘기고
// 사장님이 아침에 읽을 3~4문장 브리핑을 받는다.
function buildBriefingContext(dash, forecast, weatherImpact) {
  const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
  const L = [];
  L.push(`[카페] ${dash.cafeName} — 서울 연희동`);
  L.push(`[오늘] ${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  L.push(
    `[가장 최근 영업일 ${dash.latestDay.date}(${dash.latestDay.weekday}), 날씨 ${dash.latestDay.weather}] ` +
      `매출 ${won(dash.latestDay.revenue)}, 손님 ${dash.latestDay.visitors}명, 주문 ${dash.latestDay.orderCount}건, ` +
      `객단가 ${won(dash.latestDay.avgTicket)}` +
      (dash.latestDay.changePct != null ? `, 직전 영업일 대비 ${dash.latestDay.changePct > 0 ? '+' : ''}${dash.latestDay.changePct}%` : '')
  );
  L.push(
    `[이번 주 매출 ${dash.week.from}~${dash.week.to}] 합계 ${won(dash.week.total)}` +
      (dash.week.changePct != null ? ` (지난주 대비 ${dash.week.changePct > 0 ? '+' : ''}${dash.week.changePct}%)` : '') +
      ' / 일별: ' +
      dash.week.days.map((d) => `${d.weekday} ${Math.round(d.revenue / 10000)}만원`).join(', ')
  );
  L.push(
    '[최근 7일 인기 메뉴] ' +
      dash.topMenus.map((m) => `${m.rank}위 ${m.name} ${m.qty}개(${won(m.amount)})`).join(', ')
  );
  if (dash.reviews.avgRating != null) {
    L.push(`[최근 30일 리뷰] 평균 ${dash.reviews.avgRating}점 / ${dash.reviews.count}건`);
    dash.reviews.recent.forEach((r) => {
      L.push(`  - ${r.date} ${r.source} ${r.rating}점 (${r.menu}): ${r.content}`);
    });
  }
  if (dash.restock.length) {
    L.push(
      '[안전재고 이하 — 발주 필요] ' +
        dash.restock.map((i) => `${i.itemName} ${i.currentStock}${i.unit}(안전 ${i.safetyStock}${i.unit}, ${i.supplier})`).join(', ')
    );
  } else {
    L.push('[재고] 안전재고 이하 품목 없음');
  }
  if (weatherImpact && weatherImpact.length) {
    L.push('[날씨별 하루 평균 매출] ' + weatherImpact.map((w) => `${w.weather} ${won(w.avgRevenue)}(${w.days}일)`).join(', '));
  }
  if (forecast) {
    L.push(
      `[오늘 날씨 예보] ${forecast.summary}, ${forecast.tempMin}~${forecast.tempMax}℃, 강수확률 ${forecast.rainChance}%`
    );
  }
  if (dash.todos.length) {
    L.push('[사장님 할 일] ' + dash.todos.map((t) => `${t.done ? '완료' : '미완료'}: ${t.content}`).join(', '));
  }
  return L.join('\n');
}

// OpenAI 키가 없거나 호출이 실패하면 쓰는 규칙 기반 브리핑 (대시보드가 빈 화면이 되지 않게)
function fallbackBriefing(dash, forecast) {
  const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
  const parts = [];
  const d = dash.latestDay;
  parts.push(
    `최근 영업일(${d.date} ${d.weekday}) 매출은 ${won(d.revenue)}` +
      (d.changePct != null ? `로 직전 영업일 대비 ${d.changePct > 0 ? '+' : ''}${d.changePct}%예요.` : '였어요.')
  );
  if (dash.topMenus[0]) {
    parts.push(`최근 7일 판매 1위는 ${dash.topMenus[0].name}(${dash.topMenus[0].qty}개)입니다.`);
  }
  if (forecast) {
    parts.push(
      `오늘은 ${forecast.summary}, 강수확률 ${forecast.rainChance}%예요.` +
        (forecast.rainChance >= 60 ? ' 비 오는 날은 손님이 줄어드니 디저트 세트 할인을 걸어보세요.' : '')
    );
  }
  if (dash.restock.length) {
    parts.push(`${dash.restock.map((i) => i.itemName).join(', ')} 재고가 안전재고 이하예요. 오늘 발주 넣으세요.`);
  }
  return parts.join(' ');
}

async function generateBriefing(pool) {
  const dash = await getDashboard(pool);
  const [forecast, weatherImpact] = await Promise.all([getTodayForecast(), getWeatherImpact(pool)]);
  const context = buildBriefingContext(dash, forecast, weatherImpact);

  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return { briefing: fallbackBriefing(dash, forecast), model: 'rule-based', forecast, generatedAt: new Date().toISOString() };
  }

  const system =
    '너는 서울 연희동 카페 "Day On(데이온)" 사장님의 운영 참모다. ' +
    '아래 카페 운영 데이터를 종합해 사장님이 아침에 30초 안에 읽을 "오늘의 카페 브리핑"을 쓴다.\n' +
    '규칙:\n' +
    '- 한국어 존댓말, 3~4문장. 각 문장은 줄바꿈으로 구분.\n' +
    '- 반드시 데이터에 있는 구체적 숫자(매출/증감률/판매량/별점/재고)를 인용한다. 없는 숫자를 지어내지 않는다.\n' +
    '- 마지막 문장은 오늘 당장 실행할 액션 1가지 제안 (날씨 예보와 재고/인기메뉴를 엮어서).\n' +
    '- 이모지는 문장당 최대 1개. 마케팅 미사여구 금지.';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        max_tokens: 400,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: context },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI 응답 오류 (HTTP ${res.status}) ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error('OpenAI 응답에 본문이 없습니다.');
    return { briefing: text.trim(), model: 'gpt-4o-mini', forecast, generatedAt: new Date().toISOString() };
  } catch (err) {
    console.error('AI 브리핑 생성 실패 → 규칙 기반으로 대체:', err.message);
    return {
      briefing: fallbackBriefing(dash, forecast),
      model: 'rule-based',
      forecast,
      generatedAt: new Date().toISOString(),
      warning: 'AI 호출에 실패해 기본 브리핑을 표시합니다.',
    };
  }
}

module.exports = {
  ADMIN_USERNAME,
  requireAdmin,
  ensureAdminSchema,
  getDashboard,
  generateBriefing,
  listTodos,
  addTodo,
  toggleTodo,
  removeTodo,
  httpError,
};
