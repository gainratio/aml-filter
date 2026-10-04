import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App.tsx";
import { i18n } from "./i18n";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Root element #root not found");
}

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<I18nextProvider i18n={i18n}>
			<App />
		</I18nextProvider>
	</React.StrictMode>,
);
