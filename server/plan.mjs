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
    t.status = t.reportAt ? 'done' : t.briefAt ? 'running' : 'todo';
  }

  const done = tasks.filter((t) => t.status === 'done').length;
  const finished = tasks.filter((t) => t.status === 'done' && t.briefAt && t.reportAt);
  // 표본이 하나뿐이면 평균이라 부를 수 없다. 추정을 아예 내지 않는다.
  const avgMs =
    finished.length >= 2
      ? finished.reduce((a, t) => a + (t.reportAt - t.briefAt), 0) / finished.length
      : null;

  return {
    planFile: newest.f,
    tasks,
    done,
    total: tasks.length,
    avgMs,
    etaMs: avgMs === null ? null : avgMs * (tasks.length - done),
    staleCount,
  };
}
