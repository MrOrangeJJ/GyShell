import React from "react";

interface RendererErrorBoundaryProps {
  children: React.ReactNode;
}

interface RendererErrorBoundaryState {
  failed: boolean;
}

/**
 * Last-resort React guard. Recovery is automatic so the renderer does not add
 * a new error screen or alter the workspace's visual contract.
 */
export class RendererErrorBoundary extends React.Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[RendererErrorBoundary] React render failure", error, info);
    window.setTimeout(() => {
      window.location.reload();
    }, 0);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
