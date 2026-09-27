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
		</footer>
	);
}
