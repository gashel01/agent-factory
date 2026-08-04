/** Central icon vocabulary for the cockpit.
 *
 *  Every glyph in the UI resolves to one Lucide icon here, so the whole surface
 *  reads as a single line-icon family. Two kinds of consumer:
 *   - JSX sites import the named icons directly and render `<Play size={14} />`.
 *   - Data-driven icons (companion feed emitted by the server as emoji) resolve
 *     through {@link companionIcon} / {@link CompanionIcon}, keeping the wire
 *     format human-readable while the client draws a real icon.
 *
 *  Sizing convention: 12 for inline chips/kbd, 14 for buttons and list rows,
 *  16–18 for standalone affordances. Alignment is handled globally via the
 *  `.lucide` class in style.css.
 */
import type { JSX } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpFromLine, ArrowUpRight,
  Ban, Bell, BellOff, BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleCheckBig, CircleDot, CircleHelp, CircleX, Command, CornerDownLeft, CornerDownRight,
  DollarSign, ExternalLink, Eye, FileText, FlaskConical, Flag, FlagTriangleRight,
  Folder, FolderOpen, FolderPlus, GitBranch, GitMerge, Hand, Infinity as InfinityIcon,
  Key, Laptop, Lightbulb, Lock, MessageCircle, MessageSquare, MoreHorizontal, Palette,
  Pause, Pencil, Play, Plus, RotateCw, Rocket, Search, Send, ShieldCheck, Smartphone, Sparkles, Square, Target,
  Timer, Trash2, TrendingDown, TriangleAlert, Upload, X,
} from "lucide-react";

export {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpFromLine, ArrowUpRight,
  Ban, Bell, BellOff, BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Circle,
  CircleCheckBig, CircleDot, CircleHelp, CircleX, Command, CornerDownLeft, CornerDownRight,
  DollarSign, ExternalLink, Eye, FileText, FlaskConical, Flag, FlagTriangleRight,
  Folder, FolderOpen, FolderPlus, GitBranch, GitMerge, Hand, InfinityIcon,
  Key, Laptop, Lightbulb, Lock, MessageCircle, MessageSquare, MoreHorizontal, Palette,
  Pause, Pencil, Play, Plus, RotateCw, Rocket, Search, Send, ShieldCheck, Smartphone, Sparkles, Square, Target,
  Timer, Trash2, TrendingDown, TriangleAlert, Upload, X,
};
export type { LucideIcon };

/** Server-sent companion emoji → a Lucide icon. The server keeps emitting emoji
 *  (readable on the wire and used for cheap equality checks); the client draws them. */
const COMPANION: Record<string, LucideIcon> = {
  "🚀": Rocket,          // run kickoff
  "✅": CircleCheckBig,  // ticket shipped
  "🎯": Target,          // milestone
  "🔎": Search,          // looking into something
  "•": CircleDot,        // minor note
  "↻": RotateCw,         // retry
  "⛔": Ban,             // blocked
  "✋": Hand,            // needs your approval
  "❌": CircleX,         // failed
  "💰": DollarSign,      // spend so far
  "💸": TrendingDown,    // over budget
  "⏸": Pause,           // paused
  "🏁": FlagTriangleRight, // run finished
  "🤖": Bot,             // assistant briefing
};

export function companionIcon(emoji: string): LucideIcon {
  return COMPANION[emoji] ?? CircleDot;
}

/** Render helper for a server-sent companion emoji. */
export function CompanionIcon({ emoji, size = 14 }: { emoji: string; size?: number }): JSX.Element {
  const Icon = companionIcon(emoji);
  return <Icon size={size} aria-hidden />;
}
