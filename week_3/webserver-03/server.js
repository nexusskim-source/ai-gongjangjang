const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const server = http.createServer((req, res) => {
  // 1) 메인 페이지: index.html 서빙
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html 을 불러오지 못했습니다.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });

  // 2) 비밀번호 API: pass.txt 파일을 읽어서 JSON 으로 돌려준다
  } else if (req.url === '/api/password') {
    fs.readFile(path.join(__dirname, 'pass.txt'), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'pass.txt 를 읽지 못했습니다.' }));
        return;
      }
      // 파일 내용을 그대로(공백/줄바꿈만 제거) 비밀번호로 사용
      const password = data.trim();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ password }));
    });

  // 3) 그 외 경로
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  console.log('브라우저에서 위 주소를 열어 "비밀번호 보기" 버튼을 눌러보세요. (종료: Ctrl+C)');
});
