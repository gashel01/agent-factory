/** The Chat tab: what needs the operator, then the conversation thread, then
 *  the composer. The thread sticks to the newest message like a messaging app,
 *  unless the operator scrolled up to read history. "Every detail" reveals the
 *  chatty observations; "Raw log" swaps the story for the unfolded event feed. */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Observation } from "../../../companion.js";
import { useWarden } from "../../data.js";
import { Bot } from "../../icons.js";
import { Empty } from "../../ui.js";
import { Composer } from "./Composer.js";
import { NeedsYouList } from "./NeedsYouList.js";
import { RawLog, Thinking, Thread } from "./Thread.js";
import type { SupervisorChat } from "./useSupervisorChat.js";

/** Distance from the bottom (px) under which the view keeps following new messages. */
const PIN_SLACK = 80;

export function ChatTab({ obs, chat }: { obs: Observation[]; chat: SupervisorChat }): JSX.Element {
  const w = useWarden();
  const [showAll, setShowAll] = useState(false);
  const [raw, setRaw] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const feed = w.model.feed;
  // Ages ("2m") refresh with the shell clock while a run ticks; otherwise on each new message.
  const now = Math.max(w.now, Date.now());

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [obs.length, chat.thinking, chat.progress, raw, feed.length]);

  const hasStory = obs.length > 0 || feed.length > 0;

  return (
    <div className="sv-chat">
      <div className="sv-scroll" ref={scrollRef} onScroll={onScroll}>
        <NeedsYouList />
        {hasStory && (
          <div className="sv-controls">
            {!raw && (
              <button type="button" className="sv-toggle" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                Every detail
              </button>
            )}
            <button type="button" className="sv-toggle" aria-pressed={raw} title="The raw, unfolded event log for this run"
              onClick={() => setRaw((v) => !v)}>Raw log</button>
          </div>
        )}
        {raw
          ? <RawLog feed={feed} />
          : obs.length > 0
            ? <Thread obs={obs} showAll={showAll} now={now} />
            : !chat.thinking && (
              <Empty icon={<Bot size={22} />} title="I'm watching your runs">
                Ask me anything below, and I'll flag whatever needs you.
              </Empty>
            )}
        {chat.thinking && <Thinking progress={chat.progress} />}
      </div>
      <Composer chat={chat} />
    </div>
  );
}
