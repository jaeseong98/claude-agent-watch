// 화면. 4초마다 /api/sessions를 읽어 다시 그린다.
//
// 프레임워크를 안 쓴다. 카드 몇 개를 4초마다 갈아 끼우는 일에 빌드 단계와
// node_modules를 얹으면, 받아서 돌려보려는 사람에게 그게 첫 관문이 된다.

const POLL_MS = 4000;
// 파일 mtime과 꼬리만 읽는 값이라 이보다 잦게 부를 이유가 없고, 잦으면 수십
// MB짜리 트랜스크립트를 계속 건드리게 된다.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let now = Date.now();
// 어느 카드를 펼쳐 두었는지. 다시 그려도 유지돼야 한다. 4초마다 접히면
// 긴 멘트를 끝까지 읽을 수가 없다.
const expanded = new Set();
// 계획의 태스크 목록을 펼쳐 두었는지. 멘트 펼침과 따로 관리한다.
const planOpen = new Set();

// ── 포맷 ────────────────────────────────────────────────
const hhmmss = (ms) =>
  new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hhmm = (ms) =>
  new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });

const dur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
};
const ago = (at) => `${dur(now - at)} 전`;

// ── 계획 진행률 ─────────────────────────────────────────
function renderPlan(plan, sessionId) {
  const box = el('div', 'plan');
  const open = planOpen.has(sessionId);

  const head = el('div', 'plan-head');
  head.append(el('span', null, '계획'));
  head.append(el('span', 'count', `${plan.done}/${plan.total}`));
  if (plan.etaMs !== null) {
    head.append(el('span', null, `평균 ${dur(plan.avgMs)} · 남은 ${plan.total - plan.done}개 ≈ ${dur(plan.etaMs)}`));
  }
  head.append(el('span', 'file mono', plan.planFile));

  const toggle = el('button', 'more plan-toggle', open ? '접기' : '태스크 보기');
  toggle.addEventListener('click', () => {
    if (open) planOpen.delete(sessionId);
    else planOpen.add(sessionId);
    render(lastData);
  });
  head.append(toggle);
  box.append(head);

  const bars = el('div', 'bars');
  for (const t of plan.tasks) {
    const b = el('i', t.status === 'todo' ? '' : t.status);
    b.title = `${t.n}. ${t.title}`;
    bars.append(b);
  }
  box.append(bars);

  // 접었을 때는 진행 중인 것만, 펼치면 전부. 11개를 늘 늘어놓으면 카드가
  // 계획표가 되어 정작 지금 벌어지는 일이 밀려난다.
  const shown = open ? plan.tasks : plan.tasks.filter((t) => t.status === 'running');
  if (shown.length) {
    const list = el('div', 'tasks');
    for (const t of shown) {
      const row = el('div', `task ${t.status}`);
      row.append(el('span', 'mark', t.status === 'done' ? '✓' : t.status === 'running' ? '▸' : '·'));
      row.append(el('span', 'label', `${t.n}. ${t.title}`));
      if (t.status === 'done' && t.briefAt && t.reportAt) {
        row.append(el('span', 'dur mono', dur(t.reportAt - t.briefAt)));
      } else if (t.status === 'running' && t.briefAt) {
        row.append(el('span', 'dur mono', `${dur(now - t.briefAt)}째`));
      }
      list.append(row);
    }
    box.append(list);
  }
  if (open && plan.staleCount) {
    box.append(
      el('div', 'hint', `.superpowers/sdd/에 지난 계획 파일 ${plan.staleCount}개가 남아 있어 제외했다.`)
    );
  }
  return box;
}

// ── 서브에이전트 시간축 ─────────────────────────────────
// 지나간 에이전트를 시간 순으로 늘어놓는다. 카드의 타임라인은 지금 이 순간만
// 답하지만, 이건 "지난 몇 시간 동안 뭘 했나"에 답한다.
//
// 겹치는 구간은 실측으로 0이었다(서브에이전트는 대체로 순차 실행). 그래도
// 병렬로 띄우는 사람이 있으니 겹치면 아래 줄로 쌓는다.
function renderLanes(history, nowMs) {
  const from = Math.min(...history.map((a) => a.startedAt));
  const to = nowMs;
  const span = Math.max(to - from, 60_000);

  // 겹치지 않게 레인에 채워 넣는다.
  const lanes = [];
  for (const a of history) {
    const end = a.running ? to : a.endedAt;
    let lane = lanes.find((l) => l.end <= a.startedAt);
    if (!lane) {
      lane = { end: 0, items: [] };
      lanes.push(lane);
    }
    lane.items.push({ ...a, end });
    lane.end = end;
  }

  const box = el('div', 'lanes');

  const head = el('div', 'lanes-head');
  head.append(el('span', null, '서브에이전트'));
  head.append(el('span', 'mono', `${history.length}개`));
  head.append(el('span', 'range mono', `${hhmm(from)} ~ 지금`));
  box.append(head);

  for (const lane of lanes) {
    const row = el('div', 'lane');
    for (const a of lane.items) {
      const bar = el('div', `bar${a.running ? ' running' : ''}`);
      // 시간축 위 위치. 왼쪽 끝이 가장 오래된 에이전트, 오른쪽 끝이 지금.
      bar.style.left = `${((a.startedAt - from) / span) * 100}%`;
      bar.style.width = `${Math.max(((a.end - a.startedAt) / span) * 100, 0.6)}%`;
      bar.title = `${a.description}\n${hhmm(a.startedAt)} ~ ${a.running ? '진행 중' : hhmm(a.endedAt)} (${dur(a.end - a.startedAt)})\n${a.model}`;
      bar.append(el('span', 'bar-label', a.description));
      row.append(bar);
    }
    box.append(row);
  }
  return box;
}

// ── 세션 카드 ───────────────────────────────────────────
function renderCard(s) {
  const card = el('div', `card${s.live ? ' live' : ''}`);

  const head = el('div', 'card-head');
  head.append(el('span', `dot ${s.live ? 'on' : 'idle'}`));
  head.append(el('span', 'project', s.project));
  if (s.title) {
    head.append(el('span', 'sep', '›'));
    const t = el('span', 'title', s.title);
    t.title = s.title;
    head.append(t);
  }
  const status = el('span', `status ${s.live ? 'run' : 'idle'}`, s.live ? '실행 중' : ago(s.lastAt));
  head.append(status);
  card.append(head);

  if (s.lastPrompt) {
    const req = el('div', 'request');
    req.append(el('span', 'tag', '요청'));
    req.append(document.createTextNode(s.lastPrompt));
    card.append(req);
  }

  for (const a of s.liveAgents) {
    const row = el('div', 'agent');
    row.append(el('span', null, '▸'));
    row.append(el('span', 'name', a.description));
    const bits = [a.model, `${a.toolCount}툴`];
    if (a.startedAt) bits.push(dur(now - a.startedAt));
    row.append(el('span', 'meta mono', bits.join(' · ')));
    card.append(row);
  }

  if (s.lastNarration) {
    const key = s.sessionId;
    const open = expanded.has(key);
    const say = el('div', `say${open ? '' : ' clamped'}`, s.lastNarration.detail);
    card.append(say);

    const foot = el('div', 'say-foot');
    foot.append(el('span', 'mono', hhmmss(s.lastNarration.ts)));
    if (s.lastNarration.agent) foot.append(el('span', null, s.lastNarration.agent));

    // 길이는 실제로 잘렸는지로 판단한다. 글자 수로 어림하면 줄바꿈이 많은
    // 짧은 글에도 버튼이 붙는다.
    const btn = el('button', 'more', open ? '접기' : '전체 보기');
    btn.addEventListener('click', () => {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      render(lastData);
    });
    foot.append(btn);
    // 잘리지 않았고 펼치지도 않았으면 버튼을 숨긴다. 렌더 후에 재어야 해서
    // 다음 프레임에 확인한다.
    requestAnimationFrame(() => {
      if (!expanded.has(key) && say.scrollHeight <= say.clientHeight + 1) btn.hidden = true;
    });
    card.append(foot);
  }

  if (s.busyWith) {
    const b = el('div', 'busy');
    b.append(el('span', 'tool mono', s.busyWith.name));
    const what = el('span', 'what mono', s.busyWith.detail);
    what.title = s.busyWith.detail;
    b.append(what);
    b.append(el('span', 'elapsed mono', `${dur(now - s.busyWith.ts)}째`));
    card.append(b);
  } else {
    card.append(el('div', 'busy none', '툴을 도는 중은 아니다. 다음 판단을 고르는 중이거나 사람을 기다린다.'));
  }

  if (s.agentHistory?.length) card.append(renderLanes(s.agentHistory, now));

  // 계획은 세션 카드 안에, 맨 아래에 둔다. 이 세션의 프로젝트에서 읽은
  // 것이라는 사실이 위치로 드러나야 한다.
  if (s.plan) card.append(renderPlan(s.plan, s.sessionId));

  return card;
}

// ── 전체 ────────────────────────────────────────────────
let lastData = { now: Date.now(), sessions: [] };

function render(data) {
  now = data.now ?? Date.now();
  const live = data.sessions.filter((s) => s.live);
  const idle = data.sessions.filter((s) => !s.live);

  const liveBox = $('live');
  liveBox.replaceChildren();
  const pill = $('live-count');
  pill.hidden = live.length === 0;
  pill.textContent = `${live.length} LIVE`;

  if (!live.length) {
    liveBox.append(el('div', 'empty', data.error ?? '지금 돌고 있는 세션이 없다.'));
  } else {
    const grid = el('div', 'cards');
    for (const s of live) grid.append(renderCard(s));
    liveBox.append(grid);
  }

  const idleBox = $('idle');
  idleBox.replaceChildren();
  if (idle.length) {
    idleBox.append(el('div', 'hint', `최근에 쓴 세션 ${idle.length}개`));
    for (const s of idle) {
      const row = el('div', 'idle-row');
      row.append(el('span', 'dot idle'));
      row.append(el('span', 'project', s.project));
      if (s.title) {
        row.append(el('span', 'sep', '›'));
        row.append(el('span', 'title', s.title));
      }
      row.append(el('span', 'when mono', ago(s.lastAt)));
      idleBox.append(row);
    }
  }
}

async function tick() {
  try {
    const res = await fetch('./api/sessions');
    if (!res.ok) throw new Error(String(res.status));
    lastData = await res.json();
    $('conn-dot').className = 'dot on';
    $('conn-text').textContent = '연결됨';
  } catch {
    // 서버가 잠깐 죽어도 마지막 목록은 남긴다. 비우면 "세션이 없다"로 읽혀
    // 실제로 없는 것과 구분이 안 된다. 대신 표시등을 끈다.
    $('conn-dot').className = 'dot off';
    $('conn-text').textContent = '서버 없음';
  }
  render(lastData);
}

// ── 테마 ────────────────────────────────────────────────
const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('caw-theme', t);
  $('theme-btn').textContent = t === 'dark' ? '☀️' : '🌙';
};
applyTheme(
  localStorage.getItem('caw-theme') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
);
$('theme-btn').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
);

tick();
setInterval(tick, POLL_MS);
