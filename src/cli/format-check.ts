import type { CheckProblem, WorkspaceCheck } from '../system-files/check.js';

/**
 * What `pero check` found: each file's problems under its path, as in
 * `modle: unknown property (did you mean model?)`, then a summary.
 */
export function formatCheck(result: WorkspaceCheck): string {
  const byFile = new Map<string, CheckProblem[]>();
  for (const problem of result.problems) {
    byFile.set(problem.file, [...(byFile.get(problem.file) ?? []), problem]);
  }
  const lines: string[] = [];
  for (const [file, problems] of byFile) {
    lines.push(file);
    for (const { property, message } of problems) {
      lines.push(`  ${property === null ? '' : `${property}: `}${message}`);
    }
  }
  if (lines.length > 0) lines.push('');

  const { problems, agents, workflows, systemFolder } = result;
  if (problems.length > 0) {
    lines.push(
      `${count(problems.length, 'problem')} in ${count(byFile.size, 'file')}.`,
    );
  } else {
    lines.push(
      `Checked ${count(agents, 'Agent')} and ${count(workflows, 'Workflow')} in ${systemFolder}: no problems.`,
    );
  }
  if (!result.topicsChecked && systemFolder !== null) {
    lines.push(
      "Topic titles weren't checked against Telegram's topics, since Pero isn't running.",
    );
  }
  return lines.join('\n');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
