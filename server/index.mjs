#!/usr/bin/env node
// claude-agent-watch
//
// Claude Code 세션과 서브에이전트가 지금 무엇을 하고 있는지 한 화면에 띄운다.
// 의존성 없음, 빌드 없음. `node server/index.mjs` 하나로 끝난다.
//
// 훅을 설치하지 않는다. Claude Code가 이미 디스크에 쓰고 있는 트랜스크립트를
// 읽을 뿐이므로 세션 재시작도, 프로젝트별 설정도 필요 없다.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessions } from './sessions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/api/sessions') {
    let body;
    try {
      body = JSON.stringify(getSessions());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      // 폴링이라 캐시가 끼면 값이 멈춘 것처럼 보인다.
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // 정적 파일. 경로를 정규화해 public 밖으로 나가는 요청을 막는다.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = normalize(join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`claude-agent-watch  http://${HOST}:${PORT}\n`);
});
