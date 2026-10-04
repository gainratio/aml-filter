// A tiny, dependency-free XML reader for the flat sanctions feeds (EU/UN).
//
// These feeds are shallow, well-formed, attribute- or text-leaf XML — no mixed
// content, no namespaces we care about, no CDATA in the fields we read. A focused
// tag scanner is enough and keeps the publisher dependency-light and deterministic.
// It is NOT a general XML parser; it is fixture-validated against the committed
// EU/UN samples.

/** A parsed element: its attributes and the raw inner XML between its tags. */
export interface XmlElement {
	readonly attrs: Record<string, string>;
	readonly inner: string;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

/** Decode the five predefined XML entities. */
function decodeXml(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
}

/** Parse the attributes off a start-tag's attribute string. */
function parseAttrs(attrText: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
	for (let m = re.exec(attrText); m !== null; m = re.exec(attrText)) {
		const key = m[1];
		const val = m[2];
		if (key !== undefined && val !== undefined) {
			attrs[key] = decodeXml(val);
		}
	}
	return attrs;
}

/** All `<tag ...>...</tag>` (and self-closing `<tag .../>`) elements in `xml`. */
export function elements(xml: string, tag: string): XmlElement[] {
	const out: XmlElement[] = [];
	const re = new RegExp(`<${tag}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${tag}>)`, "g");
	for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
		out.push({ attrs: parseAttrs(m[1] ?? ""), inner: m[3] ?? "" });
	}
	return out;
}

/** The first element with `tag`, or undefined. */
export function firstElement(xml: string, tag: string): XmlElement | undefined {
	return elements(xml, tag)[0];
}

/** The decoded text of the first `<tag>text</tag>`, or undefined. */
export function textOf(xml: string, tag: string): string | undefined {
	const el = firstElement(xml, tag);
	if (el === undefined) {
		return undefined;
	}
	const trimmed = el.inner.trim();
	return trimmed === "" ? undefined : decodeXml(trimmed);
}
