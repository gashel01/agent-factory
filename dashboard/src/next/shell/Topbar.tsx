/** Each page's header: its title, a one-line context, its own actions on the
 *  right, then the palette and supervisor shortcuts every page shares. */

import type { JSX, ReactNode } from "react";
import { MessageSquare, Search } from "../icons.js";
import { useWarden } from "../data.js";
import { IconBtn } from "../ui.js";

export function Topbar({ title, sub, children, lead }: {
  title: ReactNode; sub?: ReactNode; children?: ReactNode; lead?: ReactNode;
}): JSX.Element {
  const w = useWarden();
  return (
    <header className="topbar">
      {lead}
      <h1 className="topbar-title">{title}</h1>
      {sub && <span className="topbar-sub">{sub}</span>}
      <div className="spacer" />
      {children}
      <IconBtn label="Search and commands (Ctrl+K)" boxed onClick={() => w.open({ type: "palette" })}><Search size={17} /></IconBtn>
      <IconBtn label={w.supervisorOpen ? "Close the supervisor" : "Open the supervisor"} boxed on={w.supervisorOpen}
        onClick={() => w.setSupervisorOpen(!w.supervisorOpen)}><MessageSquare size={17} /></IconBtn>
    </header>
  );
}
