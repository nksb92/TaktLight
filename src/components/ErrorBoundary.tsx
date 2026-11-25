import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/errorReporting";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stackSnippet = info.componentStack
      ? ` | componentStack: ${info.componentStack.trim().slice(0, 400)}`
      : "";
    reportError("UI render crash", `${error.message || String(error)}${stackSnippet}`);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          data-testid="error-boundary-fallback"
          className="min-h-screen bg-void text-mist flex items-center justify-center p-6 font-sans"
        >
          <div className="max-w-lg w-full bg-slate border border-signal rounded-panel p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-signal font-mono text-xs uppercase tracking-wider font-semibold">
              <span>TaktLight Studio — Unexpected UI Error</span>
            </div>
            <p className="text-sm text-frost">
              An unexpected interface error occurred. Your DMX engine state and
              autosave snapshots remain preserved on disk.
            </p>
            <pre className="bg-pitch border border-steel rounded p-3 text-xs font-mono text-fog overflow-x-auto whitespace-pre-wrap break-words max-h-48">
              {this.state.error.message || String(this.state.error)}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="px-4 py-2 rounded bg-ember hover:bg-burnt text-frost text-xs font-semibold transition-colors"
              >
                Reload Application
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
