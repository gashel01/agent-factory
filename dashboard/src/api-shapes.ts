/** Response shapes of dashboard API routes the UI reads (pull requests,
 *  knowledge docs, Docker status, autopilot loop, projects, network). */

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  isDraft: boolean;
}

export interface KnowledgeDoc {
  id: string; name: string; size: number; addedTs: string; chunks: number | null; error?: string;
}

export interface DockerStatus {
  engine: boolean; image: boolean; proxy: boolean; ready: boolean;
  detail?: string; building?: boolean; buildOk?: boolean | null; buildLog?: string;
}

export interface LoopState {
  state: string; // idle | running | done | error
  name?: string; objective?: string; integ?: string; base?: string;
  budget?: number; maxIterations?: number; iteration?: number; spent?: number;
  stop?: string; accepted?: boolean; pr?: string;
}

export interface PortfolioProject {
  name: string; workdir: string; currentRun: string | null; running: boolean;
  counts: { queued: number; working: number; needs: number; merged: number };
  total: number; spend: number; tokens: number; budget: number | null; ended: boolean; updatedTs: string | null;
}

export interface NetInfo { ip: string | null; port: number; url: string | null }
