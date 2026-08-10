/* Extracted from app.tsx — mechanical split. */
/** Agent Factory dashboard — React app. Mounts into #app. */

export { readPref, useTheme } from “./screens-theme.js”;
export type { Appearance, ThemeMode } from “./screens-theme.js”;
export { AppearanceButton, AppearanceModal } from “./screens-appearance.js”;
export { AppBar, SupervisorDock, AgentVersionChip } from “./screens-header.js”;
export { PageHead, StatTile, SegBar } from “./screens-layout.js”;
export { DiffModal, ReviewModal } from “./screens-review.js”;
export { DESTRUCTIVE_HINT, QUICK_REPLIES, RunGuardModal, AnswerModal } from “./screens-modals.js”;
export { PortfolioProject, projStatus, ProjectCard, usePortfolio, Onboarding, ProjectEditor, PhoneCard, ProjectsScreen } from “./screens-projects.js”;
export type { Fact } from “./screens-memory.js”;
export { FactEditor, FactCard, useFacts, MemoryScreen } from “./screens-memory.js”;

