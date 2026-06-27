// toao-app 백엔드 서버 (Node.js 내장 http 모듈만 사용, 외부 패키지 불필요)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TODOS_DIR = path.join(__dirname, 'todos');

// "키: 값" 형식의 txt 한 파일을 파싱해 객체로 변환
function parseTodoFile(content) {
  // 키별 매핑: 파일의 한글 키 -> JSON 필드명
  const keyMap = {
    '제목': 'title',
    '마감일': 'dueDate',
    '상태': 'status',
    '메모': 'memo',
  };

  const result = { title: '', dueDate: '', status: '', memo: '' };

  content.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const rawKey = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const field = keyMap[rawKey];
    if (field) result[field] = value;
  });

  return result;
}

// 객체 -> txt 파일 내용 문자열로 직렬화 ("키: 값" 형식)
function serializeTodo({ title = '', dueDate = '', status = '진행 전', memo = '' }) {
  return [
    `제목: ${title}`,
    `마감일: ${dueDate}`,
    `상태: ${status}`,
    `메모: ${memo}`,
    '',
  ].join('\n');
}

// 새 할 일 파일명 생성: 기존 "할일N.txt" 중 가장 큰 N+1 사용
function nextTodoFilename() {
  let files = [];
  try {
    files = fs.readdirSync(TODOS_DIR);
  } catch (err) {
    fs.mkdirSync(TODOS_DIR, { recursive: true });
  }
  let max = 0;
  files.forEach((name) => {
    const m = name.match(/^할일(\d+)\.txt$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `할일${max + 1}.txt`;
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

// filename 검증: todos 폴더 안의 단일 .txt 파일만 허용 (경로 탈출 차단)
function resolveSafeTodoPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename); // 디렉터리 구분자 제거
  if (base !== filename) return null;
  if (!base.toLowerCase().endsWith('.txt')) return null;
  const full = path.join(TODOS_DIR, base);
  if (!full.startsWith(TODOS_DIR)) return null;
  return full;
}

// todos 폴더의 모든 *.txt 파일을 읽어 배열로 반환
function readTodos() {
  let files;
  try {
    files = fs.readdirSync(TODOS_DIR);
  } catch (err) {
    // 폴더가 없으면 빈 배열
    return [];
  }

  const txtFiles = files
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .sort((a, b) => a.localeCompare(b, 'ko')); // 파일명 정렬

  return txtFiles.map((filename, i) => {
    const filePath = path.join(TODOS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf8'); // 한글 → 반드시 UTF-8
    const parsed = parseTodoFile(content);
    return {
      id: i + 1,
      filename,
      title: parsed.title,
      dueDate: parsed.dueDate,
      status: parsed.status,
      memo: parsed.memo,
    };
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // API: 할 일 목록
  if (req.method === 'GET' && url === '/api/todos') {
    try {
      const todos = readTodos();
      const body = JSON.stringify(todos);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: 'todos 읽기 실패: ' + err.message }));
    }
    return;
  }

  // API: 할 일 추가 (새 txt 파일 생성)
  if (req.method === 'POST' && url === '/api/todos') {
    readJsonBody(req)
      .then((body) => {
        const title = (body.title || '').trim();
        if (!title) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '제목은 필수입니다.' }));
          return;
        }
        const todo = {
          title,
          dueDate: (body.dueDate || '').trim(),
          status: (body.status || '진행 전').trim(),
          memo: (body.memo || '').trim(),
        };
        const filename = nextTodoFilename();
        fs.writeFileSync(path.join(TODOS_DIR, filename), serializeTodo(todo), 'utf8');
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, filename, ...todo }));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      });
    return;
  }

  // API: 할 일 수정 (filename + 변경할 필드를 JSON 본문으로 받아 해당 txt 파일 갱신)
  if (req.method === 'PUT' && url === '/api/todos') {
    readJsonBody(req)
      .then((body) => {
        const full = resolveSafeTodoPath(body.filename);
        if (!full) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '유효하지 않은 파일명입니다.' }));
          return;
        }
        if (!fs.existsSync(full)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '해당 할 일을 찾을 수 없습니다.' }));
          return;
        }
        // 기존 내용을 읽어 전달된 필드만 덮어쓴다 (부분 수정 지원)
        const current = parseTodoFile(fs.readFileSync(full, 'utf8'));
        const updated = {
          title: body.title !== undefined ? String(body.title).trim() : current.title,
          dueDate: body.dueDate !== undefined ? String(body.dueDate).trim() : current.dueDate,
          status: body.status !== undefined ? String(body.status).trim() : current.status,
          memo: body.memo !== undefined ? String(body.memo).trim() : current.memo,
        };
        if (!updated.title) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '제목은 비울 수 없습니다.' }));
          return;
        }
        fs.writeFileSync(full, serializeTodo(updated), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, filename: body.filename, ...updated }));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      });
    return;
  }

  // API: 할 일 삭제 (filename을 JSON 본문으로 받아 해당 txt 파일 삭제)
  if (req.method === 'DELETE' && url === '/api/todos') {
    readJsonBody(req)
      .then((body) => {
        const full = resolveSafeTodoPath(body.filename);
        if (!full) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '유효하지 않은 파일명입니다.' }));
          return;
        }
        if (!fs.existsSync(full)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '해당 할 일을 찾을 수 없습니다.' }));
          return;
        }
        fs.unlinkSync(full);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, filename: body.filename }));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      });
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
  console.log(`toao-app 서버 실행 중: http://localhost:${PORT}`);
});

module.exports = server;
