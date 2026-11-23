/** Small display helpers. */

export function initials(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export interface TreeNode {
  name: string;
  path: string;
  /** Present for files, absent for folders. */
  fileId?: string;
  children: TreeNode[];
}

/** Turn flat file paths (`src/app.ts`) into a folder tree: folders first, then files, A to Z. */
export function buildTree(files: ReadonlyArray<{ id: string; name: string }>): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.name.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && (c.fileId !== undefined) === isFile);
      if (!child) {
        child = isFile ? { name: part, path, fileId: file.id, children: [] } : { name: part, path, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const folderA = a.fileId === undefined;
      const folderB = b.fileId === undefined;
      if (folderA !== folderB) return folderA ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}
