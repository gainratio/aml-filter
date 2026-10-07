import {
	subscribeVectorIndexStorage,
	vectorIndexFallbackLists,
} from "@amlfilter/browser";
import { type ReactNode, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { listName } from "../lib/plainLabels";
import "../styles/common.css";

interface LayoutProps {
	children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
	const { t } = useTranslation("common");
	const { pathname } = useLocation();
	// Per list: a later list opening on persistent storage must not hide an
	// earlier list whose index is still held in memory.
	const fallbackLists = useSyncExternalStore(
		subscribeVectorIndexStorage,
		vectorIndexFallbackLists,
	);
	const navItems = [
		{ path: "/screen", label: t("nav.screen") },
		{ path: "/customers", label: t("nav.customers") },
		{ path: "/review", label: t("nav.review") },
		{ path: "/settings", label: t("nav.settings") },
	];
	const isActive = (path: string) =>
		pathname === path || pathname.startsWith(`${path}/`);

	return (
		<div className="page-container">
			<header className="nav-header">
				<nav className="nav-container" aria-label="Primary navigation">
					<div className="nav-links">
						<Link to="/" className="nav-brand" aria-label={t("nav.brand")}>
							<img
								src="/logo.svg"
								alt={t("nav.brandAlt")}
								className="nav-brand__logo"
							/>
							<span className="nav-brand__name">{t("nav.brand")}</span>
						</Link>
						<div className="nav-workspace">
							{/* The local-first workstation — no login, no API keys. */}
							{navItems.map(({ path, label }) => {
								const active = isActive(path);
								return (
									<Link
										key={path}
										to={path}
										className={`nav-link${active ? " nav-link--active" : ""}`}
										aria-current={active ? "page" : undefined}
									>
										{label}
									</Link>
								);
							})}
						</div>
					</div>
				</nav>
			</header>
			{fallbackLists.length > 0 ? (
				<p
					className="page-notice text-muted"
					role="status"
					data-testid="index-fallback-notice"
				>
					{t("indexFallback.notice", {
						lists: fallbackLists.map((id) => listName(id, t)).join(", "),
					})}
				</p>
			) : null}
			<main className="page-main">{children}</main>
			<footer className="page-footer">
				<small>{t("layoutFooter")}</small>{" "}
				<small>
					<a
						className="page-footer__source"
						href="https://github.com/gainratio/aml-filter"
						rel="noopener noreferrer"
						target="_blank"
					>
						{t("layoutFooterSource")}
					</a>
				</small>
			</footer>
		</div>
	);
}
