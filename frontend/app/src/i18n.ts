/**
 * i18next initialization — bundled catalogs, no runtime fetch.
 *
 * Every translation JSON is imported STATICALLY below, so Vite bundles + hashes
 * them into the app chunk. The app never reaches the network for strings, exactly
 * like the rest of AML-Filter (OFAC screening, the KYC workstation, and delta-sync
 * all run in the tab, zero backend calls). That is "no backend", not "offline":
 * there is no service worker, so loading the page still needs the network.
 *
 * English is the authoritative baseline. Adding a locale is copy-paste: duplicate
 * `locales/en/` to `locales/<lang>/`, translate the values, and register it in
 * `resources` + `supportedLngs` below. The parity test (locales.parity.test.ts)
 * then auto-enforces that the new locale covers every en key — no test edit.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en/common.json";
import enCustomers from "./locales/en/customers.json";
import enErrors from "./locales/en/errors.json";
import enLanding from "./locales/en/landing.json";
import enReview from "./locales/en/review.json";
import enScreen from "./locales/en/screen.json";
import enSettings from "./locales/en/settings.json";

/** The registered namespaces. Kept in one place so config + parity test agree. */
const I18N_NAMESPACES = [
	"common",
	"landing",
	"screen",
	"customers",
	"review",
	"settings",
	"errors",
] as const;

const resources = {
	en: {
		common: enCommon,
		landing: enLanding,
		screen: enScreen,
		customers: enCustomers,
		review: enReview,
		settings: enSettings,
		errors: enErrors,
	},
} as const;

// Inline resources are added to the store synchronously during init(), so the
// very first render already resolves real copy (no Suspense, no raw-key flash).
// useSuspense:false keeps the provider-less component specs from suspending on a
// (here impossible) not-ready read.
void i18n.use(initReactI18next).init({
	resources,
	lng: "en",
	fallbackLng: "en",
	supportedLngs: ["en"],
	ns: I18N_NAMESPACES,
	defaultNS: "common",
	returnNull: false,
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

export { i18n };
