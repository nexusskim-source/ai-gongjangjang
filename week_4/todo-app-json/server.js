// todo-app-json 백엔드 서버 (Node.js 내장 http 모듈만 사용, 외부 패키지 불필요)
// 데이터는 단일 JSON 파일(todos.json) 하나로 관리한다.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'todos.json');

const VALID_STATUS = ['진행 전', '진행 중', '완료'];

// todos.json 읽기 (없으면 빈 배열). 한글 → 반드시 UTF-8.
function readTodos() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    // 파일이 없거나 깨졌으면 빈 목록으로 시작
    return [];
  }
}

// todos 배열을 todos.json 에 저장 (사람이 읽기 좋게 들여쓰기)
function writeTodos(todos) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(todos, null, 2) + '\n', 'utf8');
}

// 다음 id: 현재 최대 id + 1
function nextId(todos) {
  return todos.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
}

// 입력 todo 정규화 (필드 정리 + 상태 검증)
function normalizeTodo({ title = '', dueDate = '', status = '진행 전', memo = '' }) {
  const s = String(status).trim();
  return {
    title: String(title).trim(),
    dueDate: String(dueDate).trim(),
    status: VALID_STATUS.includes(s) ? s : '진행 전',
    memo: String(memo).trim(),
  };
}

// 요청 본문(JSON)을 읽어 파싱
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // 과도한 입력 방어
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('잘못된 JSON 형식입니다.'));
      }
    });
    req.on('error', reject);
  });
}

// JSON 응답 헬퍼
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // API: 할 일 목록
  if (req.method === 'GET' && url === '/api/todos') {
    try {
      sendJson(res, 200, readTodos());
    } catch (err) {
      sendJson(res, 500, { success: false, message: 'todos 읽기 실패: ' + err.message });
    }
    return;
  }

  // API: 할 일 추가
  if (req.method === 'POST' && url === '/api/todos') {
    readJsonBody(req)
      .then((body) => {
        const todo = normalizeTodo(body);
        if (!todo.title) {
          return sendJson(res, 400, { success: false, message: '제목은 필수입니다.' });
        }
        const todos = readTodos();
        const created = { id: nextId(todos), ...todo };
        todos.push(created);
        writeTodos(todos);
        sendJson(res, 201, { success: true, ...created });
      })
      .catch((err) => sendJson(res, 400, { success: false, message: err.message }));
    return;
  }

  // API: 할 일 수정 (id + 변경할 필드를 받아 해당 항목 갱신, 부분 수정 지원)
  if (req.method === 'PUT' && url === '/api/todos') {
    readJsonBody(req)
      .then((body) => {
        const id = Number(body.id);
        if (!id) {
          return sendJson(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
        }
        const todos = readTodos();
        const idx = todos.findIndex((t) => Number(t.id) === id);
        if (idx === -1) {
          return sendJson(res, 404, { success: false, message: '해당 할 일을 찾을 수 없습니다.' });
        }
        const current = todos[idx];
        // 전달된 필드만 덮어쓴다
        const merged = normalizeTodo({
          title: body.title !== undefined ? body.title : current.title,
          dueDate: body.dueDate !== undefined ? body.dueDate : current.dueDate,
          status: body.status !== undefined ? body.status : current.status,
          memo: body.memo !== undefined ? body.memo : current.memo,
        });
        if (!merged.title) {
          return sendJson(res, 400, { success: false, message: '제목은 비울 수 없습니다.' });
        }
        todos[idx] = { id, ...merged };
        writeTodos(todos);
        sendJson(res, 200, { success: true, ...todos[idx] });
      })
      .catch((err) => sendJson(res, 400, { success: false, message: err.message }));
    return;
  }

  // API: 할 일 삭제 (id를 받아 해당 항목 제거)
  if (req.method === 'DELETE' && url === '/api/todos') {
    readJsonBody(req)
      .then((body) => {
        const id = Number(body.id);
        if (!id) {
          return sendJson(res, 400, { success: false, message: '유효하지 않은 id 입니다.' });
        }
        const todos = readTodos();
        const idx = todos.findIndex((t) => Number(t.id) === id);
        if (idx === -1) {
          return sendJson(res, 404, { success: false, message: '해당 할 일을 찾을 수 없습니다.' });
        }
        todos.splice(idx, 1);
        writeTodos(todos);
        sendJson(res, 200, { success: true, id });
      })
      .catch((err) => sendJson(res, 400, { success: false, message: err.message }));
    return;
  }

  // 정적 파일: 루트 → index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html을 찾을 수 없습니다. (아직 생성되지 않았을 수 있습니다)');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 그 외 같은 폴더의 정적 파일 서빙 (예: client.js, css 등)
  if (req.method === 'GET') {
    const safePath = path.normalize(decodeURIComponent(url)).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, safePath);
    // __dirname 밖 접근 차단
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('접근 금지');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
    return;
  }

  // 그 외
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`todo-app-json 서버 실행 중: http://localhost:${PORT}`);
});

module.exports = server;
