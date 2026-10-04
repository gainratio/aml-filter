/** Error Boundary component for catching and displaying JavaScript errors gracefully. */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { i18n } from "../i18n";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { hasError: true, error };
	}

	override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		this.setState({ errorInfo });
		// Log error to console in development
		console.error("ErrorBoundary caught an error:", error, errorInfo);
	}

	handleReset = (): void => {
		this.setState({ hasError: false, error: null, errorInfo: null });
	};

	override render(): ReactNode {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<div className="error-boundary">
					<div className="error-boundary-content">
						<h1>{i18n.t("errors:boundary.title")}</h1>
						<p>{i18n.t("errors:boundary.body")}</p>
						{this.state.error && (
							<details className="error-details">
								<summary>{i18n.t("errors:boundary.detailsSummary")}</summary>
								<pre className="error-message">{this.state.error.message}</pre>
								{this.state.errorInfo && (
									<pre className="error-stack">
										{this.state.errorInfo.componentStack}
									</pre>
								)}
							</details>
						)}
						<div className="error-actions">
							<button
								type="button"
								className="btn btn-primary"
								onClick={this.handleReset}
							>
								{i18n.t("errors:boundary.tryAgain")}
							</button>
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => window.location.reload()}
							>
								{i18n.t("errors:boundary.refresh")}
							</button>
						</div>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
