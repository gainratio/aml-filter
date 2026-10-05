import type { Entity } from "@amlfilter/browser";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DossierCard, dossierFromEntity } from "./DossierCard";

const DIRECTORY_PAGE_SIZE = 24;

interface EntityDirectoryProps {
	readonly entities: ReadonlyArray<Entity>;
}

function boundedPage(page: number, totalPages: number): number {
	return Math.max(0, Math.min(page, totalPages - 1));
}

export function EntityDirectory({ entities }: EntityDirectoryProps) {
	const { t } = useTranslation("screen");
	const [requestedPage, setRequestedPage] = useState(0);
	const totalPages = Math.max(
		1,
		Math.ceil(entities.length / DIRECTORY_PAGE_SIZE),
	);
	const page = boundedPage(requestedPage, totalPages);
	const start = page * DIRECTORY_PAGE_SIZE;
	const end = Math.min(start + DIRECTORY_PAGE_SIZE, entities.length);
	const visible = entities.slice(start, end);
	const number = new Intl.NumberFormat("en-US");

	return (
		<section className="screen-results">
			<p className="screen-results__count" role="status" aria-live="polite">
				{t("results.directoryRange", {
					start: number.format(entities.length === 0 ? 0 : start + 1),
					end: number.format(end),
					total: number.format(entities.length),
				})}
			</p>
			<ul className="screen-results__list">
				{visible.map((entity) => (
					<DossierCard
						key={entity.entity_id}
						dossier={dossierFromEntity(entity)}
					/>
				))}
			</ul>
			<nav
				className="screen-directory__pagination"
				aria-label={t("results.pagination.ariaLabel")}
			>
				<button
					type="button"
					className="screen-directory__button"
					disabled={page === 0}
					onClick={() => setRequestedPage(page - 1)}
				>
					{t("results.pagination.previous")}
				</button>
				<span className="screen-directory__page">
					{t("results.pagination.page", {
						page: number.format(page + 1),
						total: number.format(totalPages),
					})}
				</span>
				<button
					type="button"
					className="screen-directory__button"
					disabled={page >= totalPages - 1}
					onClick={() => setRequestedPage(page + 1)}
				>
					{t("results.pagination.next")}
				</button>
			</nav>
		</section>
	);
}
