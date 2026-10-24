/**
 * Small footer shared by the landing and the in-browser screening page. States
 * plainly that the search runs in this tab over PUBLIC sanctions data, and
 * credits the data source with a not-legal-advice line — so nobody mistakes it
 * for unattributed data or a compliance guarantee.
 */
import { useTranslation } from "react-i18next";

export function Footer() {
	const { t } = useTranslation("common");
	return (
		<footer className="screen-footer">
			<p className="screen-footer__line">{t("demoFooter.line1")}</p>
			<p className="screen-footer__line screen-footer__line--muted">
				{t("demoFooter.line2")}
			</p>
			<nav className="screen-footer__nav" aria-label="Guides">
				<a className="screen-footer__link" href="/ofac-check/">
					OFAC check
				</a>
				<a className="screen-footer__link" href="/sanctions-screening/">
					Sanctions screening
				</a>
				<a
					className="screen-footer__link"
					href="/sanctions-screening-without-uploading-data/"
				>
					Without upload
				</a>
				<a className="screen-footer__link" href="/eu-sanctions-list/">
					EU, UN and UK lists
				</a>
				<a className="screen-footer__link" href="/trust/">
					Trust and verification
				</a>
			</nav>
		</footer>
	);
}
