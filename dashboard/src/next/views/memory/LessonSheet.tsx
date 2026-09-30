/** The "lesson" overlay: a new lesson drafted from elsewhere (a ticket's log,
 *  the palette), prefilled with its text and origin ticket. */

import type { JSX } from "react";
import { useWarden } from "../../data.js";
import { LessonEditor } from "./LessonEditor.js";

export function LessonSheet({ text, ticketId }: { text: string; ticketId?: string }): JSX.Element {
  const w = useWarden();
  return <LessonEditor fact={null} draft={{ text, ticketId }} onClose={w.close} onSaved={() => { /* Memory reloads when it's shown */ }} />;
}
