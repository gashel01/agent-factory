/** Agent Factory dashboard — render-error containment, so one panel's exception
 *  shows a readable fallback instead of blanking the whole dashboard. */

import { Component } from "react";
import type { ErrorInfo, JSX, ReactNode } from "react";
import { TriangleAlert } from "./icons.js";
import { useEsc } from "./core.js";

/** Escape closes the error dialog, like every other overlay (hooks can't live in the class). */
function CloseOnEscape({ onClose }: { onClose: () => void }): null {
  useEsc(onClose);
  return null;
}

interface Props {
  /** Human name of the guarded area, shown in the fallback ("Board", "Settings"…). */
  name: string;
  /** Changing this clears a caught error (e.g. the open modal's type). */
  resetKey?: unknown;
  /** Render the fallback as a dialog over the page (for modals/drawers). */
  overlay?: boolean;
  /** Offered as a "Close" action in the fallback (e.g. dismiss the crashed modal). */
  onClose?: () => void;
  children: ReactNode;
}
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[${this.props.name}] render error:`, error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private readonly retry = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { name, overlay, onClose } = this.props;
    const card: JSX.Element = (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-title"><TriangleAlert size={16} /> {name} hit an error</div>
        <p className="error-boundary-msg mono">{error.message || String(error)}</p>
        <div className="error-boundary-acts">
          <button type="button" className="btn primary sm" onClick={this.retry}>Try again</button>
          <button type="button" className="btn ghost sm" onClick={() => location.reload()}>Reload</button>
          {onClose && <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>}
        </div>
      </div>
    );
    if (!overlay) return card;
    return (
      <div className="overlay" onClick={(e) => { if (onClose && e.target === e.currentTarget) onClose(); }}>
        {onClose && <CloseOnEscape onClose={onClose} />}
        <div className="panel" role="dialog" aria-modal="true" aria-label={`${name} error`}>{card}</div>
      </div>
    );
  }
}
