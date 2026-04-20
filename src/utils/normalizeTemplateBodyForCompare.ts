/**
 * Normalize template text so on-disk encoding (UTF-8 BOM, CRLF) and Rewst API bodies (typically LF) compare reliably.
 */
export function normalizeTemplateBodyForCompare(s: string): string {
	const withoutBom = s.startsWith('\uFEFF') ? s.slice(1) : s;
	return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
