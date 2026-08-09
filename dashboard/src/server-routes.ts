/* Extracted from server.ts — mechanical split of the HTTP router.
 *
 * The router is a sequence of route-group handlers. Each takes a shared context
 * and returns true if it wrote the response (request handled), false to let the
 * next group try. server.ts owns the static routes, the auth gate, workspace
 * resolution and the 404 fallback, and calls the handlers in order. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options, Workspace, Registry } from "./server-core.js";

/** Everything the workspace-independent route groups need. */
export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  registry: Registry;
  opts: Options;
  token: string;
  publicDir: string;
  here: string;
  globalMemFile: string;
}

/** Per-workspace route groups also get the resolved workspace. */
export interface WsRouteCtx extends RouteCtx {
  ws: Workspace;
}
