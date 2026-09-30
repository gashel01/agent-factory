/** Response shapes of the supervisor's shared surfaces (server-routes-architecture.ts).
 *  Mirrors the classic views' local interfaces — the server is the contract. */

export interface ArchNode { id: string; label: string; kind: string }
export interface ArchGraph {
  nodes: ArchNode[];
  edges: Array<{ from: string; to: string }>;
  truncated: boolean;
  total: number;
}

/** GET/PUT /api/architecture — the agents' world-model, your notes, the import graph. */
export interface ArchData {
  map: {
    symbols: Array<{ name: string; file: string }>;
    decisions: Array<{ key: string; value: string; ticket: string }>;
    files: Array<{ file: string; ticket: string }>;
  };
  notes: string;
  graph?: ArchGraph;
}

/** GET /api/coordination — who holds which files, what they published and decided. */
export interface CoordAgent { ticket: string; files: string[]; state: "live" | "landed" | "released"; symbols: string[] }
export interface CoordData {
  run: string | null;
  agents: CoordAgent[];
  symbols: Array<{ name: string; file: string; ticket: string }>;
  decisions: Array<{ key: string; value: string; ticket: string }>;
  discoveries: Array<{ ticket: string; note: string }>;
}

/* GET/PUT /api/board — the sketch board, persisted whole to <workspace>/board.json. */
export type BoardLayer = "human" | "agent";
export interface BoxShape {
  id: string; kind: "rect" | "db" | "sticky"; layer: BoardLayer;
  x: number; y: number; w: number; h: number; text?: string;
}
export interface ArrowShape {
  id: string; kind: "arrow"; layer: BoardLayer;
  x1: number; y1: number; x2: number; y2: number;
}
export type Shape = BoxShape | ArrowShape;
export const isBox = (s: Shape): s is BoxShape => s.kind !== "arrow";
