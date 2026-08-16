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
import { spawn } from 'node:child_process';
import { getSessions } from './sessions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
// 창을 여는 것은 프로세스를 띄우는 일이다. 다른 기기에서 부를 수 있으면
// 안 된다. 서버가 루프백에 묶여 있고 요청도 루프백에서 온 경우에만 연다.
const localOnly = (req) => LOOPBACK.test(HOST) && LOOPBACK.test(req.socket.remoteAddress ?? '');

// 화면을 두 가지 모습으로 띄운다.
//   widget  화면 가장자리에 세우는 좁은 창 (앱 모드)
//   web     평소 쓰는 기본 브라우저의 보통 탭
function openView(mode) {
  const url = `http://127.0.0.1:${PORT}/${mode === 'widget' ? '?widget=1' : ''}`;

  if (mode === 'widget') {
    if (process.platform !== 'win32') {
      throw new Error('위젯 창은 지금 Windows에서만 연다. 다른 곳에서는 브라우저 창 크기를 줄이면 같은 배치가 된다.');
    }
    // detached를 쓰지 않는다. 쓰면 실행 파일이 분명히 있는데도 spawn이
    // ENOENT로 죽는다(실측: 절대경로로 줘도 같았다). 그리고 필요도 없다.
    // widget.ps1은 Start-Process로 크롬을 띄우고 몇 초 만에 끝나므로,
    // 크롬은 이미 이 서버와 무관한 독립 프로세스다.
    spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(ROOT, 'widget.ps1')],
      { cwd: ROOT, stdio: 'ignore' }
    ).on('error', () => {});
    return;
  }

  // 기본 브라우저로 연다. 위젯 창은 전용 프로필을 쓰므로 거기서 window.open을
  // 하면 평소 쓰는 브라우저가 아니라 그 격리된 프로필에서 열린다.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore' }).on('error', () => {});
}

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

  if (url.pathname === '/api/open' && req.method === 'POST') {
    if (!localOnly(req)) {
      res.writeHead(403, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ error: '이 기기에서만 창을 열 수 있다.' }));
      return;
    }
    const mode = url.searchParams.get('mode') === 'widget' ? 'widget' : 'web';
    try {
      openView(mode);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, mode }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
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
