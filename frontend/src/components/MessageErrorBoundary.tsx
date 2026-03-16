import React from "react";

interface MessageErrorBoundaryProps {
  children: React.ReactNode;
}

interface MessageErrorBoundaryState {
  hasError: boolean;
}

export default class MessageErrorBoundary extends React.Component<
  MessageErrorBoundaryProps,
  MessageErrorBoundaryState
> {
  constructor(props: MessageErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): MessageErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-testid="message-error"
          className="mx-4 my-1 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          Failed to render message
        </div>
      );
    }
    return this.props.children;
  }
}
