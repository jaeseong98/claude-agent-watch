// 계획 진행률. superpowers SDD 워크플로의 파일 규약을 읽어 "몇 개 중 몇 개"를 낸다.
//
// 규약을 안 쓰는 프로젝트에서는 그냥 null이 나오고 화면에서 사라진다.
// 그러니 이 도구를 쓰기 위해 규약을 따라야 할 이유는 없다.
//
// 읽는 것:
//   <projectRoot>/docs/superpowers/plans/<가장 최근>.md   에서 `## Task N: 제목`
//   <projectRoot>/.superpowers/sdd/task-N-brief.md        태스크 시작
//   <projectRoot>/.superpowers/sdd/task-N-report.md       태스크 완료

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 브리프가 이보다 오래됐는데 보고서가 없으면 진행 중이 아니다. 실측으로
// 태스크 하나는 9~39분이 걸렸다. 넉넉히 잡아도 세 시간이면 충분하다.
const RUNNING_MAX_MS = 3 * 60 * 60 * 1000;

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * @param {string} projectRoot 세션의 cwd. 세션마다 다르므로 인자로 받는다.
 * @returns {object|null} 계획을 못 찾으면 null (화면에서 통째로 빠진다)
 */
export function getPlanProgress(projectRoot) {
  if (!projectRoot) return null;

  const plansDir = join(projectRoot, 'docs', 'superpowers', 'plans');
  const sddDir = join(projectRoot, '.superpowers', 'sdd');

  let planFiles;
  try {
    planFiles = readdirSync(plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, mtime: statSafe(join(plansDir, f))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }

  const newest = planFiles[0];
  if (!newest) return null;

  let text;
  try {
    text = readFileSync(join(plansDir, newest.f), 'utf8');
  } catch {
    return null;
  }

  const tasks = [];
  for (const line of text.split('\n')) {
    const m = /^##\s+Task\s+(\d+)\s*:\s*(.+)$/.exec(line.trim());
    if (m && m[1] && m[2]) {
      tasks.push({ n: Number(m[1]), title: m[2].trim(), status: 'todo', briefAt: null, reportAt: null });
    }
  }
  if (!tasks.length) return null;

  // .superpowers/sdd/는 계획이 바뀌어도 비워지지 않아 지난 계획의 task-N 파일이
  // 남는다. 이번 회차의 시작(task-1-brief)보다 오래된 것은 잔재로 보고 버린다.
  const baseline = statSafe(join(sddDir, 'task-1-brief.md'))?.mtimeMs ?? 0;
  let staleCount = 0;

  for (const t of tasks) {
    const brief = statSafe(join(sddDir, `task-${t.n}-brief.md`));
    const report = statSafe(join(sddDir, `task-${t.n}-report.md`));
    t.briefAt = brief && brief.mtimeMs >= baseline ? brief.mtimeMs : null;
    t.reportAt = report && report.mtimeMs >= baseline ? report.mtimeMs : null;
    if ((brief && !t.briefAt) || (report && !t.reportAt)) staleCount++;
    t.status = t.reportAt ? 'done' : t.briefAt ? 'started' : 'todo';
  }

  // 브리프만 있고 보고서가 없는 것을 전부 "진행 중"으로 보면 안 된다.
  // 실측으로 16시간째 진행 중인 태스크 다섯 개가 한꺼번에 떴는데, 실제로는
  // 어젯밤에 시작만 되고 보고서가 안 남은 것들이었다. 태스크 하나는 9~39분이
  // 걸렸으니 16시간짜리 진행 중은 있을 수 없다.
  //
  // SDD는 순차 실행이다. 그러니 브리프가 가장 늦게 생긴 것 하나만 지금 돌고
  // 있을 수 있고, 그보다 앞선 것들은 이미 끝났거나 버려진 것이다.
  const startedTasks = tasks.filter((t) => t.status === 'started');
  const latestStarted = startedTasks.reduce((a, b) => (!a || b.briefAt > a.briefAt ? b : a), null);
  for (const t of startedTasks) {
    // 가장 최근 브리프이면서 아직 그럴듯한 시간 안에 있어야 진행 중이다.
    // 아니면 '시작만 되고 보고서가 없음'이다. 그것도 알아야 할 정보다.
    t.status = t === latestStarted && Date.now() - t.briefAt < RUNNING_MAX_MS ? 'running' : 'abandoned';
  }

  const done = tasks.filter((t) => t.status === 'done').length;
  const finished = tasks.filter((t) => t.status === 'done' && t.briefAt && t.reportAt);
  // 표본이 하나뿐이면 평균이라 부를 수 없다. 추정을 아예 내지 않는다.
  const avgMs =
    finished.length >= 2
      ? finished.reduce((a, t) => a + (t.reportAt - t.briefAt), 0) / finished.length
      : null;

  const remaining = tasks.length - done;
  return {
    planFile: newest.f,
    tasks,
    done,
    total: tasks.length,
    avgMs,
    // 남은 게 없으면 추정할 것도 없다. 0을 주면 화면에 "남은 0개 ≈ 0초"라는
    // 빈 문구가 남는다.
    etaMs: avgMs === null || remaining === 0 ? null : avgMs * remaining,
    // 다 끝난 계획은 사라지지 않는다. 그 프로젝트의 현재 상태이기 때문이다.
    // 대신 언제 끝났는지를 같이 줘서, 진행 중인 것처럼 보이지 않게 한다.
    completedAt: remaining === 0 ? Math.max(...tasks.map((t) => t.reportAt ?? 0)) : null,
    staleCount,
  };
}
