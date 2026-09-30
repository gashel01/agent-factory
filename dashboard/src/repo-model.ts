/** The repository browser's pure model: file tree folding and commit shape. */

export interface TreeNode { name: string; path: string; isFile: boolean; children: Map<string, TreeNode> }

/** Fold flat repo paths ("src/components/Nav.tsx") into a nested folder tree. */
export function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFile: false, children: new Map() };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), isFile, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

/** Folders first, then files; alphabetical within each. */
export function sortedEntries(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1);
}

export interface Commit { hash: string; date: string; author: string; subject: string; body: string; parents: string[]; refs: string[] }
