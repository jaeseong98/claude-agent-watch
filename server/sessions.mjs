// 세션 현황. Claude Code가 디스크에 쓰는 트랜스크립트를 직접 읽는다.
//
// 훅으로 이벤트를 받는 방식에는 두 가지 구멍이 있다.
//   1. 훅은 세션 시작 시점에 읽히므로, 이미 돌고 있는 창은 재시작 전까지
//      아무것도 안 보낸다.
//   2. 훅은 프로젝트별 .claude/settings.json에 달린다. 다른 프로젝트에서
//      돌리는 창은 거기에도 설치해야 보인다.
// 그 결과 "지금 두 창에서 뭔가 돌고 있는데 대시보드는 비어 있다"가 된다.
//
// 이 모듈은 반대 방향이다. 파일만 읽으므로 설치도 재시작도 필요 없고,
// 이미 지나간 것까지 보인다. 대신 훅만큼 즉각적이지는 않다(폴링).
//
// 읽는 것:
//   ~/.claude/projects/<slug>/<session>.jsonl             메인 루프
//   ~/.claude/projects/<slug>/<session>/subagents/*.jsonl  서브에이전트
//   ~/.claude/projects/<slug>/<session>/subagents/*.meta.json  설명·모델

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getPlanProgress } from './plan.mjs';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

// 메인 트랜스크립트는 수십 MB까지 자란다(실측 37MB). 폴링마다 통째로 읽으면
// 서버가 디스크에 묶인다. 꼬리만 읽고 첫 줄(잘렸을 수 있다)은 버린다.
// 바이트 경계에서 잘린 UTF-8 문자도 이 규칙으로 함께 사라진다.
const TAIL_BYTES = 256 * 1024;
// 이보다 오래 조용한 세션은 목록에 넣지 않는다. 몇 달치가 쌓여 있다.
const ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
// 툴을 붙잡고 있지 않을 때, 이 안에 기록이 있으면 아직 살아 있다고 본다.
const LIVE_MS = 90 * 1000;
// 이보다 오래 결과가 안 온 툴은 미완료로 치지 않는다. 그렇게 오래 도는 툴은
// 사실상 없고, 꼬리 밖으로 결과가 밀려난 경우일 가능성이 높다.
const MAX_TOOL_RUN_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 8;
const MAX_TIMELINE = 12;

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function readTail(file, bytes = TAIL_BYTES) {
  const st = statSafe(file);
  if (!st) return '';
  const start = Math.max(0, st.size - bytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

function toolDetail(block) {
  const i = block?.input ?? {};
  const raw = i.file_path || i.command || i.pattern || i.description || i.path || i.url || i.prompt || '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  // 에이전트의 Bash는 거의 매번 `cd "<긴 경로>" && source .venv/... &&`로
  // 시작한다. 그대로 두면 화면 폭을 상용구가 다 먹고 정작 무슨 명령인지가
  // 잘려 나간다.
  s = s
    .replace(/^cd\s+(["'])?.*?\1?\s*(?:&&|;)\s*/i, '')
    .replace(/^(?:source|\.)\s+\S*activate\S*(?:\s+\d?>\S+)?\s*(?:&&|;)\s*/i, '');
  return s.slice(0, 200);
}

// 한 트랜스크립트(메인이든 서브에이전트든)의 꼬리를 훑는다.
function parseTranscript(text, agent) {
  const items = [];
  let cwd = '';
  let title = '';
  let lastPrompt = '';
  // 호출된 툴과 돌아온 결과를 짝지어 미완료를 남긴다.
  const issued = new Map();
  const returned = new Set();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.cwd) cwd = o.cwd;
    // 제목과 마지막 요청은 별도 레코드로 온다. 대화가 이어질 때마다 새로
    // 쓰이므로 마지막 것이 현재 값이다.
    if (o.type === 'ai-title' && o.aiTitle) title = String(o.aiTitle);
    if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = String(o.lastPrompt);

    const ts = Date.parse(o.timestamp ?? '');
    if (Number.isNaN(ts)) continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (b.type === 'tool_use') {
        const detail = toolDetail(b);
        items.push({ ts, kind: 'tool', name: b.name, detail, agent });
        if (b.id) issued.set(b.id, { name: b.name, detail, ts });
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        returned.add(b.tool_use_id);
      } else if (
        // 발화는 어시스턴트 것만 센다. 사용자 쪽 배열에도 text 블록이 오는데
        // (서브에이전트에 넘긴 지시문이 그렇다) 그것까지 "말"로 잡으면 방금
        // 시킨 지시가 방금 한 말인 것처럼 보인다.
        o.type === 'assistant' &&
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text.trim()
      ) {
        items.push({ ts, kind: 'text', name: '', detail: b.text.trim(), agent });
      }
    }
  }

  // 꼬리만 읽으므로 결과가 창 밖에 있는 오래된 호출은 미완료로 잘못 보일 수
  // 있다. 가장 최근 것 하나만 인정하고, 그마저도 너무 오래됐으면 버린다.
  const pendingList = [...issued.entries()]
    .filter(([id]) => !returned.has(id))
    .map(([, v]) => v)
    .sort((a, b) => a.ts - b.ts);
  const newestPending = pendingList[pendingList.length - 1] ?? null;
  const pendingTool =
    newestPending && Date.now() - newestPending.ts < MAX_TOOL_RUN_MS ? newestPending : null;

  return { items, cwd, title, lastPrompt, pendingTool };
}

function readSubagents(sessionDir, now) {
  const sub = join(sessionDir, 'subagents');
  if (!existsSync(sub)) return { agentCount: 0, liveAgents: [], items: [], pending: null };

  const files = readdirSync(sub).filter((f) => f.endsWith('.jsonl'));
  const liveAgents = [];
  const items = [];
  let pending = null;

  for (const f of files) {
    const full = join(sub, f);
    const st = statSafe(full);
    // 서브에이전트도 긴 툴을 돌면 파일이 조용해진다. mtime만 보면 일하는
    // 중인 에이전트가 목록에서 사라지므로 창을 넓게 잡고, 실제 판정은
    // 아래의 미완료 툴로 한다.
    if (!st || now - st.mtimeMs > MAX_TOOL_RUN_MS) continue;

    const id = f.replace(/^agent-|\.jsonl$/g, '');
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(sub, `agent-${id}.meta.json`), 'utf8'));
    } catch {
      /* 메타가 아직 안 쓰였을 수 있다 */
    }

    const parsed = parseTranscript(readTail(full), meta.description ?? id.slice(0, 8));
    const busy = parsed.pendingTool !== null;
    if (!busy && now - st.mtimeMs > LIVE_MS) continue;
    if (parsed.pendingTool && (!pending || parsed.pendingTool.ts > pending.ts)) {
      pending = parsed.pendingTool;
    }

    liveAgents.push({
      id,
      description: meta.description ?? '(설명 없음)',
      model: meta.model ?? '?',
      agentType: meta.agentType ?? '?',
      startedAt: parsed.items[0]?.ts ?? null,
      lastAt: st.mtimeMs,
      toolCount: parsed.items.filter((i) => i.kind === 'tool').length,
    });
    items.push(...parsed.items);
  }

  return { agentCount: files.length, liveAgents, items, pending };
}

export function getSessions() {
  const now = Date.now();
  const found = [];

  let slugs;
  try {
    slugs = readdirSync(PROJECTS_ROOT);
  } catch {
    return { now, sessions: [], error: `Claude Code 기록을 못 찾았다: ${PROJECTS_ROOT}` };
  }

  for (const slug of slugs) {
    const slugDir = join(PROJECTS_ROOT, slug);
    if (!statSafe(slugDir)?.isDirectory()) continue;

    let entries;
    try {
      entries = readdirSync(slugDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -6);
      const transcript = join(slugDir, entry);
      const st = statSafe(transcript);
      if (!st) continue;

      const sessionDir = join(slugDir, sessionId);
      const subDir = join(sessionDir, 'subagents');
      const subMtime = existsSync(subDir) ? statSafe(subDir)?.mtimeMs ?? 0 : 0;
      // 메인이 조용해도 서브에이전트가 돌고 있으면 그 세션은 살아 있다.
      const lastAt = Math.max(st.mtimeMs, subMtime);
      if (now - lastAt > ACTIVE_WINDOW_MS) continue;

      let parsed = parseTranscript(readTail(transcript));
      // 제목·마지막 요청은 꼬리 안에 대개 들어 있지만, 마지막 대화 뒤에 도구
      // 호출이 길게 이어지면 창 밖으로 밀려난다. 그때만 더 크게 읽는다.
      if ((!parsed.title || !parsed.lastPrompt) && st.size > TAIL_BYTES) {
        const wider = parseTranscript(readTail(transcript, TAIL_BYTES * 8));
        parsed.title = parsed.title || wider.title;
        parsed.lastPrompt = parsed.lastPrompt || wider.lastPrompt;
      }

      const agents = readSubagents(sessionDir, now);

      const merged = [...parsed.items, ...agents.items].sort((a, b) => a.ts - b.ts);
      // 발화는 툴 열 번에 한 번쯤 나온다. 잘라낸 타임라인 안에 없을 수 있어
      // 자르기 전 전체에서 찾는다.
      const narrations = merged.filter((i) => i.kind === 'text');

      // 메인이든 서브에이전트든 하나라도 툴을 붙잡고 있으면 일하는 중이다.
      const busyWith =
        agents.pending && (!parsed.pendingTool || agents.pending.ts > parsed.pendingTool.ts)
          ? agents.pending
          : parsed.pendingTool;

      const effectiveLast = Math.max(lastAt, merged[merged.length - 1]?.ts ?? 0);

      found.push({
        sessionId,
        slug,
        cwd: parsed.cwd,
        project: parsed.cwd ? parsed.cwd.split(/[/\\]/).filter(Boolean).pop() ?? slug : slug,
        title: parsed.title,
        lastPrompt: parsed.lastPrompt,
        lastNarration: narrations[narrations.length - 1] ?? null,
        busyWith,
        // 계획은 세션의 cwd에서 읽는다. 창마다 다른 프로젝트일 수 있으므로
        // 하나의 전역 경로를 두면 어느 세션 것인지 알 수 없게 된다.
        plan: getPlanProgress(parsed.cwd),
        lastAt: effectiveLast,
        // 툴을 붙잡고 있으면 경과 시간과 무관하게 실행 중이다. 긴 Bash 한 방이
        // 도는 동안에는 트랜스크립트에 아무것도 안 쓰이기 때문이다(실측으로
        // 102초, 263초, 284초짜리 공백이 흔했다).
        live: busyWith !== null || now - effectiveLast < LIVE_MS,
        agentCount: agents.agentCount,
        liveAgents: agents.liveAgents,
        timeline: merged.slice(-MAX_TIMELINE),
      });
    }
  }

  // 돌고 있는 것을 먼저, 그 안에서 최근 순. 화면 위쪽이 지금 봐야 할 것이라야 한다.
  found.sort((a, b) => Number(b.live) - Number(a.live) || b.lastAt - a.lastAt);
  return { now, sessions: found.slice(0, MAX_SESSIONS) };
}
