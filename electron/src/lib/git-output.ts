import type { GitFileStatus, GitStatus } from "@shared/types/git";

/** NUL output preserves whitespace, Unicode and Git's otherwise quoted names. */
export function parseGitPaths(raw: string): string[] {
  return raw.split("\0").filter((file) => file.length > 0);
}

function afterFields(record: string, count: number): string {
  let offset = 0;
  for (let field = 0; field < count; field++) {
    const separator = record.indexOf(" ", offset);
    if (separator === -1) return "";
    offset = separator + 1;
  }
  return record.slice(offset);
}

const STATUSES: Record<string, GitFileStatus> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged",
};

/** Parses `git status --porcelain=v2 --branch -z`, including two-record renames. */
export function parseGitStatus(raw: string): GitStatus {
  const result: GitStatus = { branch: "HEAD", ahead: 0, behind: 0, files: [] };
  const records = raw.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith("# branch.oid ")) result.head = record.slice(13);
    else if (record.startsWith("# branch.head ")) result.branch = record.slice(14);
    else if (record.startsWith("# branch.upstream ")) result.upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const counts = /\+(\d+) -(\d+)/.exec(record);
      if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); }
    } else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const renamed = record.startsWith("2 ");
      const file = afterFields(record, renamed ? 9 : 8);
      const oldPath = renamed ? records[++index] : undefined;
      if (!file) continue;
      const change = { path: file, ...(oldPath ? { oldPath } : {}) };
      const [staged, unstaged] = record.slice(2, 4);
      if (staged !== "." && staged !== "?") {
        result.files.push({ ...change, status: STATUSES[staged] ?? "modified", group: "staged" });
      }
      if (unstaged !== "." && unstaged !== "?") {
        result.files.push({ ...change, status: STATUSES[unstaged] ?? "modified", group: "unstaged" });
      }
    } else if (record.startsWith("u ")) {
      const file = afterFields(record, 10);
      if (file) result.files.push({ path: file, status: "unmerged", group: "unstaged" });
    } else if (record.startsWith("? ")) {
      result.files.push({ path: record.slice(2), status: "untracked", group: "untracked" });
    }
  }
  return result;
}
