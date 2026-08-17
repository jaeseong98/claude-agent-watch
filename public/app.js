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
// 토큰은 자릿수가 커서(캐시 읽기가 1억을 넘는다) 그대로 쓰면 못 읽는다.
const num = (n) => {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}만`;
  return n.toLocaleString('ko-KR');
};

// ── 계획 진행률 ─────────────────────────────────────────
function renderPlan(plan, sessionId) {
  const box = el('div', 'plan');
  const open = planOpen.has(sessionId);

  // 다 끝난 계획은 사라지지 않는다. 그 프로젝트의 현재 상태이기 때문이다.
  // 대신 진행 중인 것과 다르게 보여야 한다. 초록으로 꽉 찬 막대를 그대로 두면
  // 아직 돌고 있는 것처럼 읽힌다.
  const done = plan.completedAt !== null && plan.completedAt !== undefined;
  if (done) box.classList.add('done');

  const head = el('div', 'plan-head');
  head.append(el('span', null, '계획'));
  head.append(el('span', 'count', `${plan.done}/${plan.total}`));
  // 보고서가 없어 완료를 확인할 수 없는 것들. 이게 있으면 분수만 보여선
  // 안 된다. "0/7"은 아무것도 안 됐다는 뜻으로 읽히는데, 실제로는 도구가
  // 모를 뿐이고 커밋은 되어 있을 수 있다.
  const unknown = plan.tasks.filter((t) => t.status === 'abandoned').length;

  if (done) {
    head.append(el('span', 'plan-done', '완료'));
    if (plan.completedAt) head.append(el('span', null, `${ago(plan.completedAt)}`));
  } else if (unknown) {
    head.append(el('span', 'plan-unknown', `확인 불가 ${unknown}`));
  } else if (plan.etaMs !== null) {
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
    b.title =
      `${t.n}. ${t.title}` + (t.status === 'abandoned' ? ' (시작만 되고 보고서가 없다)' : '');
    bars.append(b);
  }
  box.append(bars);

  // 접었을 때는 진행 중인 것만, 펼치면 전부. 11개를 늘 늘어놓으면 카드가
  // 계획표가 되어 정작 지금 벌어지는 일이 밀려난다.
  const shown = open
    ? plan.tasks
    : plan.tasks.filter((t) => t.status === 'running' || t.status === 'abandoned');
  if (shown.length) {
    const list = el('div', 'tasks');
    for (const t of shown) {
      const row = el('div', `task ${t.status}`);
      const mark = { done: '✓', running: '▸', abandoned: '⚠' }[t.status] ?? '·';
      row.append(el('span', 'mark', mark));
      row.append(el('span', 'label', `${t.n}. ${t.title}`));
      if (t.status === 'done' && t.briefAt && t.reportAt) {
        row.append(el('span', 'dur mono', dur(t.reportAt - t.briefAt)));
      } else if (t.status === 'running' && t.briefAt) {
        row.append(el('span', 'dur mono', `${dur(now - t.briefAt)}째`));
      } else if (t.status === 'abandoned') {
        // 몇 시간째 진행 중이라고 하면 거짓말이다. 시작만 됐다고 말한다.
        row.append(el('span', 'dur mono', '보고서 없음'));
      }
      list.append(row);
    }
    box.append(list);
  }
  if (unknown) {
    box.append(
      el(
        'div',
        'hint',
        `${unknown}개는 보고서(task-N-report.md)가 없어 완료를 확인할 수 없다. 커밋은 되어 있을 수 있다.`
      )
    );
  }
  if (open && plan.staleCount) {
    box.append(
      el('div', 'hint', `.superpowers/sdd/에 지난 계획 파일 ${plan.staleCount}개가 남아 있어 제외했다.`)
    );
  }
  return box;
}

// ── 통합 시간축 ─────────────────────────────────────────
// 모든 세션의 모든 에이전트를 하나의 시간축에 늘어놓는다.
//
// 카드마다 따로 두면 축이 카드마다 달라져 서로 비교가 안 된다. 창 셋이
// 동시에 돌 때 알고 싶은 것은 "누가 언제 무엇을 했나"이고, 그건 축이
// 하나여야 보인다.
//
// 줄 두 종류가 섞인다.
//   메인   사람이 시킨 것 하나가 구간 하나. 이름은 그때 시킨 말이다.
//   서브   서브에이전트 하나가 구간 하나. 이름은 그 에이전트의 설명이다.
function packLanes(items) {
  // 겹치면 아래 줄로 쌓는다. 서브에이전트는 실측상 순차라 대개 한 줄이지만
  // 병렬로 띄우는 사람도 있다.
  const lanes = [];
  for (const it of items) {
    let lane = lanes.find((l) => l.end <= it.startedAt);
    if (!lane) {
      lane = { end: 0, items: [] };
      lanes.push(lane);
    }
    lane.items.push(it);
    lane.end = it.end;
  }
  return lanes;
}

function renderTimeline(data) {
  const now = data.now;
  const rows = [];

  for (const s of data.sessions) {
    const main = (s.turns ?? []).map((t) => ({
      startedAt: t.startedAt,
      end: t.running ? now : t.endedAt,
      endedAt: t.endedAt,
      label: t.text,
      running: t.running,
      kind: 'main',
    }));
    const subs = (s.agentHistory ?? []).map((a) => ({
      startedAt: a.startedAt,
      end: a.running ? now : a.endedAt,
      endedAt: a.endedAt,
      label: a.description,
      running: a.running,
      kind: 'sub',
      model: a.model,
    }));
    if (!main.length && !subs.length) continue;
    rows.push({ session: s, main, subs });
  }
  if (!rows.length) return null;

  // 축은 모두가 공유한다. 가장 이른 활동부터 지금까지.
  const all = rows.flatMap((r) => [...r.main, ...r.subs]);
  const from = Math.min(...all.map((a) => a.startedAt));
  const to = now;
  const span = Math.max(to - from, 60_000);
  const pct = (t) => ((t - from) / span) * 100;

  const box = el('section', 'timeline');

  const head = el('div', 'tl-head');
  head.append(el('span', 'tl-title', '전체 활동'));
  head.append(el('span', 'hint', '메인은 요청 하나가 구간 하나, 서브는 에이전트 하나가 구간 하나'));
  head.append(el('span', 'tl-range mono', `${hhmm(from)} ~ 지금`));
  box.append(head);

  // 눈금. 30분마다, 정각에 맞춰 찍는다.
  const axis = el('div', 'tl-axis');
  const step = span > 4 * 3600e3 ? 3600e3 : 1800e3;
  const first = Math.ceil(from / step) * step;
  for (let t = first; t <= to; t += step) {
    const tick = el('span', 'tick mono', hhmm(t));
    tick.style.left = `${pct(t)}%`;
    axis.append(tick);
  }
  box.append(axis);

  for (const r of rows) {
    const group = el('div', `tl-session${r.session.live ? ' live' : ''}`);

    const label = el('div', 'tl-label');
    label.append(el('span', `dot ${r.session.live ? 'on' : 'idle'}`));
    label.append(el('span', 'project', r.session.project));
    if (r.session.title) {
      label.append(el('span', 'sep', '›'));
      const t = el('span', 'title', r.session.title);
      t.title = r.session.title;
      label.append(t);
    }
    group.append(label);

    const lanesBox = el('div', 'tl-lanes');
    const groups = [
      ['main', r.main],
      ['sub', r.subs],
    ];
    for (const [kind, items] of groups) {
      if (!items.length) continue;
      for (const lane of packLanes(items)) {
        const row = el('div', 'lane');
        for (const a of lane.items) {
          const bar = el('div', `bar ${kind}${a.running ? ' running' : ''}`);
          bar.style.left = `${pct(a.startedAt)}%`;
          bar.style.width = `${Math.max(pct(a.end) - pct(a.startedAt), 0.4)}%`;
          bar.title =
            `${kind === 'main' ? '요청' : '서브에이전트'}: ${a.label}\n` +
            `${hhmm(a.startedAt)} ~ ${a.running ? '진행 중' : hhmm(a.endedAt)} (${dur(a.end - a.startedAt)})` +
            (a.model ? `\n${a.model}` : '');
          bar.append(el('span', 'bar-label', a.label));
          row.append(bar);
        }
        lanesBox.append(row);
      }
    }
    group.append(lanesBox);
    box.append(group);
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
  if (s.gitBranch) {
    const b = el('span', 'branch mono', s.gitBranch);
    b.title = `브랜치 ${s.gitBranch}`;
    head.append(b);
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

  // 막힘. 실패 하나하나가 아니라 "나아가지 못하고 있다"일 때만 뜬다.
  // 도구 실패 대부분은 에이전트가 보고 넘어가는 정상적인 마찰이다.
  if (s.stuck) {
    const box = el('div', 'fails');
    const head = el('div', 'fail-head');
    head.append(
      el(
        'span',
        'fail-badge',
        s.stuck.reason === 'repeat' ? `같은 오류 ${s.stuck.count}회` : `오류 ${s.stuck.count}회`
      )
    );
    head.append(el('span', 'mono', `${dur(now - s.stuck.since)}째`));
    if (s.stuck.tool) head.append(el('span', 'mono', s.stuck.tool));
    box.append(head);
    box.append(el('div', 'fail-msg', s.stuck.message));
    card.append(box);
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
    // end_turn을 봤으면 사람 차례라고 단정할 수 있다. 아니면 다음 판단을
    // 고르는 짧은 사이다. 뭉뚱그리면 기다려야 할지 말지를 알 수 없다.
    card.append(
      s.awaitingUser
        ? el('div', 'busy turn', '사람 차례다. 에이전트가 답을 기다린다.')
        : el('div', 'busy none', '툴을 도는 중은 아니다. 다음 판단을 고르는 중이다.')
    );
  }

  // 토큰. 꼬리에 들어온 만큼이라 "언제부터"를 반드시 같이 적는다. 세션
  // 전체 합계인 것처럼 보이면 거짓말이 된다.
  if (s.usage && (s.usage.output || s.usage.cacheRead)) {
    const u = el('div', 'usage mono');
    u.append(el('span', 'usage-tag', '토큰'));
    u.append(el('span', null, `출력 ${num(s.usage.output)}`));
    u.append(el('span', null, `캐시읽기 ${num(s.usage.cacheRead)}`));
    if (s.usage.cacheWrite) u.append(el('span', null, `캐시쓰기 ${num(s.usage.cacheWrite)}`));
    u.append(el('span', 'usage-since', s.usage.since ? `${hhmm(s.usage.since)}부터` : ''));
    u.title =
      '트랜스크립트 꼬리 4MB에 들어온 만큼만 셌다. 세션 전체 합계가 아니다.\n' +
      `입력 ${num(s.usage.input)} · 출력 ${num(s.usage.output)}\n` +
      `캐시 읽기 ${num(s.usage.cacheRead)} · 캐시 쓰기 ${num(s.usage.cacheWrite)}`;
    card.append(u);
  }

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

  // 통합 시간축은 헤더 바로 밑. 세션별 카드보다 먼저 온다.
  const tlBox = $('timeline');
  tlBox.replaceChildren();
  const tl = renderTimeline(data);
  if (tl) tlBox.append(tl);

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

// ── 알림 ────────────────────────────────────────────────
// 이 도구의 원래 목적은 "지금 뭐 하는지 보는 것"이 아니라 "들여다보지 않아도
// 되는 것"이다. 화면을 계속 봐야 한다면 절반만 푼 것이다.
//
// 두 순간에만 부른다. 그 외에는 조용해야 알림이 신호로 남는다.
//   끝남   툴을 붙잡고 있다가 놓았고 사람 차례가 되었을 때
//   막힘   새로운 실패가 났을 때
const prev = new Map(); // sessionId -> { busy, lastFailTs }
let notifyOn = localStorage.getItem('caw-notify') === '1';
let primed = false; // 첫 응답으로는 안 부른다. 이미 쉬고 있던 것까지 다 울린다.

function updateNotifyButton() {
  const b = $('notify-btn');
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  b.textContent = notifyOn ? '🔔' : '🔕';
  b.title = denied
    ? '브라우저가 알림을 막고 있다. 주소창 왼쪽 자물쇠에서 허용해야 한다'
    : notifyOn
      ? '알림 켜짐. 작업이 끝나거나 막히면 부른다'
      : '알림 꺼짐';
  b.classList.toggle('on', notifyOn && !denied);
}

async function toggleNotify() {
  if (!notifyOn) {
    if (typeof Notification === 'undefined') {
      alert('이 브라우저는 알림을 지원하지 않는다.');
      return;
    }
    if (Notification.permission !== 'granted') {
      const res = await Notification.requestPermission();
      if (res !== 'granted') {
        updateNotifyButton();
        return;
      }
    }
    notifyOn = true;
  } else {
    notifyOn = false;
  }
  localStorage.setItem('caw-notify', notifyOn ? '1' : '0');
  updateNotifyButton();
  if (notifyOn) {
    notify('알림 켜짐', '작업이 끝나거나 막히면 이렇게 부른다.');
  }
}

function notify(title, body) {
  if (!notifyOn || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // tag를 세션별로 주면 같은 세션의 알림이 쌓이지 않고 갈아 끼워진다.
  const n = new Notification(title, { body, tag: title, icon: undefined });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

function checkTransitions(data) {
  for (const s of data.sessions) {
    const was = prev.get(s.sessionId);
    // 막힘으로 "들어선 순간"에만 부른다. 막힌 동안 4초마다 울리면 안 된다.
    const stuckSince = s.stuck ? s.stuck.since : 0;
    const waiting = Boolean(s.awaitingUser);
    const name = `${s.project}${s.title ? ` › ${s.title}` : ''}`;

    if (primed && was) {
      // 막힘이 먼저다. 오류로 멈춘 것을 "끝났다"로 알리면 거짓말이 된다.
      if (stuckSince && stuckSince !== was.stuckSince) {
        notify(
          `막힘 · ${name}`,
          `${s.stuck.tool ? s.stuck.tool + ': ' : ''}${s.stuck.message}`.slice(0, 180)
        );
      } else if (waiting && !was.waiting) {
        notify(`차례 · ${name}`, s.lastNarration?.detail?.slice(0, 180) ?? '작업이 끝났다.');
      }
    }
    prev.set(s.sessionId, { waiting, stuckSince });
  }
  primed = true;
}

async function tick() {
  try {
    const res = await fetch('./api/sessions');
    if (!res.ok) throw new Error(String(res.status));
    lastData = await res.json();
    checkTransitions(lastData);
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

// ── 모습 (웹 / 위젯) ────────────────────────────────────
// 위젯 창은 ?widget=1 로 열린다. 그래야 화면이 자기가 어느 모습인지 알고,
// 넓은 창에서도 좁은 배치를 쓸 수 있다. 폭만으로 정하면 모드 전환이 불가능하다.
const isWidget = new URLSearchParams(location.search).get('widget') === '1';
const narrow = matchMedia('(max-width: 720px)');

function applyMode() {
  document.documentElement.classList.toggle('compact', isWidget || narrow.matches);
  const b = $('mode-btn');
  b.textContent = isWidget ? '🖥' : '🪟';
  b.title = isWidget ? '브라우저 탭으로 열기' : '화면 가장자리 위젯으로 열기';
}
narrow.addEventListener('change', applyMode);

async function switchMode() {
  const mode = isWidget ? 'web' : 'widget';
  const b = $('mode-btn');
  b.disabled = true;
  try {
    const res = await fetch(`./api/open?mode=${mode}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? String(res.status));
    // 위젯에서 웹으로 넘어갈 때는 이 창을 닫아 준다. 둘이 동시에 떠 있으면
    // 어느 쪽을 보고 있는지 헷갈린다. 앱 모드 창은 스크립트로 닫을 수 있다.
    if (isWidget) setTimeout(() => window.close(), 600);
  } catch (err) {
    alert(`창을 열지 못했다: ${err.message}`);
  } finally {
    b.disabled = false;
  }
}

$('mode-btn').addEventListener('click', switchMode);
applyMode();

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
$('notify-btn').addEventListener('click', toggleNotify);
updateNotifyButton();

$('theme-btn').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
);

tick();
setInterval(tick, POLL_MS);
