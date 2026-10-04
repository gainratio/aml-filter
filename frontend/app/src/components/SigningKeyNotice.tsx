/**
 * An honest one-liner for pages that sign receipts: when the browser refused
 * persistent storage, the signing key lives only in this tab's in-memory
 * SQLite, so receipts made now cannot be checked against this browser later.
 * Renders nothing when the key is stored on the device (or cannot load — the
 * receipt badge already says so).
 */

import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useKeyService } from "../lib/installKeysContext";

export function SigningKeyNotice(): ReactElement | null {
	const { t } = useTranslation("common");
	const keys = useKeyService();
	const [temporary, setTemporary] = useState(false);
	useEffect(() => {
		let active = true;
		keys.load().then(
			(key) => active && setTemporary(key.persistence.kind === "memory"),
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [keys]);
	if (!temporary) {
		return null;
	}
	return (
		<div className="alert alert-warning" role="status">
			{t("signingKey.temporary")}
		</div>
	);
}
