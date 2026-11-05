import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { dirname, extname, join } from "node:path";
import { readFileSync } from "node:fs";

// <api-imports>
import health__get from "./api/health/GET";
// </api-imports>
import { seoRoutes } from "../lib/seo-routes";
import {
	loadAdSenseRuntimeConfig,
	resolveAdSenseTextFile,
	type AdSenseRuntimeConfig,
} from "./adsense-manifest";
import { loadIndexNowKey } from "./indexnow-key";
import { isSystemHost } from "./seo-host";
import { llmsTxtHandler } from "./llms-txt";

export interface SsrRenderResult {
	html: string;
	head: string;
	status: number;
	redirect?: string;
}

/** Stands in for the route when the request failed before Express matched one. */
const UNROUTED: string = "(unrouted)";

/**
 * Names the route a request reached, never the target it asked for.
 *
 * A request target carries visitor data: a path segment can be an address
 * (`/signup/victim@example.com`) and a parameterized route holds a customer id, so
 * `req.baseUrl + req.path` logged both. `docs/privacy/pii.md` asks for the route
 * template instead — the string this app registered, which is fixed text.
 *
 * There is deliberately no fallback to `req.path` or `req.originalUrl`: a request
 * that matched no route has no template, and the placeholder is the honest answer.
 * The mount prefix is also omitted, because `req.baseUrl` is the resolved mount
 * rather than a template, so appending it would put request-derived text back.
 */
export function routeLabel(req: Request): string {
	const route: unknown = (req as { route?: unknown }).route;
	if (typeof route !== "object" || route === null) {
		return UNROUTED;
	}
	const template: unknown = (route as { path?: unknown }).path;
	if (typeof template === "string") {
		return template;
	}
	// The SSR catch-all route is registered with a RegExp path, so `path` is a RegExp.
	// The source is text this app wrote, so it is as fixed as a string template.
	if (template instanceof RegExp) {
		return template.source;
	}
	// A route registered with an array of paths has no single template.
	return UNROUTED;
}

/** Frames worth logging. Enough to name the throwing line and its caller. */
const MAX_LOGGED_FRAMES: number = 5;

/**
 * The call frames of an error, with its message removed.
 *
 * `stack` is the message with the frames appended, so the message has to come
 * off before any of it is logged. It is removed by its own length rather than by
 * looking for where the frames begin, because a message can contain anything:
 * body-parser puts a prefix of the request body into a parse failure's message,
 * and a visitor can put newlines and text shaped like a frame in that body.
 * Cutting an exact `name: message` prefix leaves only what the runtime wrote.
 *
 * Anything that does not have that exact prefix — a `stack` reassigned by a
 * library, or a `name` or `message` changed after the error was constructed —
 * reports no frames at all, so an unrecognised shape loses debuggability rather
 * than logging an unknown string.
 */
function loggedFrames(err: Error): string[] {
	if (typeof err.stack !== "string") {
		return [];
	}
	const headline: string = err.message ? `${err.name}: ${err.message}` : err.name;
	if (!err.stack.startsWith(headline)) {
		return [];
	}
	return err.stack
		.slice(headline.length)
		.split("\n")
		.filter((line: string): boolean => /^\s+at \S/.test(line))
		.slice(0, MAX_LOGGED_FRAMES)
		.map((line: string): string => line.trim());
}

/**
 * Reduces an error to fields that cannot carry request content.
 *
 * express.json() puts a prefix of the raw request body into a SyntaxError's
 * message, so the message is not safe to log on a request path: a form-encoded
 * body posted to a JSON route begins with the visitor's own field values. The
 * error class, plus body-parser's `type` and `status`, names the failure without
 * quoting what the client sent, and {@link loggedFrames} takes the frames out of
 * `stack` without the message that `stack` begins with.
 *
 * The message is dropped rather than gated on dev, because production is where a
 * customer app is actually debugged, so a dev-only escape hatch would not be
 * read. The frames are kept and the message is not: a frame names a file, a
 * function and a line the runtime itself recorded, while the message is the only
 * part an error carries that can quote what arrived in the request.
 */
export function toLogError(err: unknown): Record<string, unknown> {
	const shaped: Record<string, unknown> = {
		name: err instanceof Error ? err.name : typeof err,
	};
	const fields: Record<string, unknown> =
		typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
	if (typeof fields.type === "string") {
		shaped.type = fields.type;
	}
	if (typeof fields.code === "string" || typeof fields.code === "number") {
		shaped.code = fields.code;
	}
	if (typeof fields.status === "number") {
		shaped.status = fields.status;
	}
	if (err instanceof Error) {
		const frames: string[] = loggedFrames(err);
		if (frames.length > 0) {
			shaped.frames = frames;
		}
	}
	return shaped;
}

/**
 * Error handler for /api routes. Exported so tests can mount it on their own app
 * in the order Express requires (error middleware after the routes it protects).
 */
export const apiErrorHandler = (
	err: unknown,
	req: Request,
	res: Response,
	_next: NextFunction,
): void => {
	// Always respond JSON on /api so clients parsing response.json() don't
	// receive Express's default HTML error page for non-Error throws.
	console.error("ssr.api.error", {
		route: routeLabel(req),
		error: toLogError(err),
	});
	res.status(500).json({ error: "Internal server error" });
};

/**
 * Last handler in the stack, for paths outside /api. Without it Express's default
 * handler runs, which writes err.stack to stderr and — whenever NODE_ENV is not
 * "production" — into the response body.
 */
export const finalErrorHandler = (
	err: unknown,
	req: Request,
	res: Response,
	// Unused, but Express identifies error middleware by arity: a 3-parameter
	// function is registered as an ordinary handler and never sees an error.
	_next: NextFunction,
): void => {
	console.error("ssr.request.failed", {
		route: routeLabel(req),
		error: toLogError(err),
	});
	if (res.headersSent) {
		// The response is already streaming, so there is no status left to set and no
		// body to replace. Forwarding to Express's default handler would hand it the
		// unsanitized error, which it writes to stderr as a raw stack — the leak this
		// handler exists to close. Destroying the socket instead aborts the partial
		// response, so the client sees a truncated transfer rather than a body that
		// looks complete. The log line above has already recorded the failure.
		res.destroy();
		return;
	}
	// Preserve the status Express's default handler would have chosen, so a
	// malformed body still answers 400 rather than 500.
	const rawStatus: unknown =
		typeof err === "object" && err !== null
			? ((err as { status?: unknown; statusCode?: unknown }).status ??
				(err as { statusCode?: unknown }).statusCode)
			: undefined;
	const status: number =
		typeof rawStatus === "number" && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
	res.status(status).type("text/plain").send("Internal Server Error");
};

export function registerAdSenseTextRoutes(app: Express, config: AdSenseRuntimeConfig): void {
	app.get("/ads.txt", (_req, res) => {
		const content = resolveAdSenseTextFile(config, "adsTxt");
		if (content === null) {
			res
				.status(404)
				.type("text/plain")
				.set("Cache-Control", "no-cache")
				.send("Not found\n");
			return;
		}
		res.type("text/plain").set("Cache-Control", "no-cache").send(content);
	});

	app.get("/app-ads.txt", (_req, res) => {
		const content = resolveAdSenseTextFile(config, "appAdsTxt");
		if (content === null) {
			res
				.status(404)
				.type("text/plain")
				.set("Cache-Control", "no-cache")
				.send("Not found\n");
			return;
		}
		res.type("text/plain").set("Cache-Control", "no-cache").send(content);
	});
}

export function renderSsrDocument(
	template: string,
	result: Pick<SsrRenderResult, "head" | "html">,
	adSenseConfig: Pick<AdSenseRuntimeConfig, "scriptHtml">,
): string {
	const head = [result.head, adSenseConfig.scriptHtml].filter(Boolean).join("\n");
	return template
		.replace("<!--app-head-->", () => head)
		.replace("<!--app-html-->", () => result.html);
}

function normalizeCommerceApiBaseUrlEnv() {
	if (process.env.GODADDY_API_BASE_URL) return;
	const hostOnly = process.env.VITE_GODADDY_API_HOST;
	if (!hostOnly) return;
	const normalizedHost = hostOnly.replace(/^https?:\/\//, "").trim();
	if (!normalizedHost) return;
	process.env.GODADDY_API_BASE_URL = `https://${normalizedHost}`;
}

normalizeCommerceApiBaseUrlEnv();

const app = express();

// Honour x-forwarded-* from the load balancer so req.protocol/req.hostname
// reflect the public-facing values. Express-maintained parsing respects the
// existing trust-proxy config; direct header reads would let a client spoof
// the sitemap origin in robots.txt.
app.set("trust proxy", true);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// <api-registrations>
app.get("/api/health", health__get);
// </api-registrations>

// Error middleware must be registered AFTER the routes it protects; Express
// only passes errors to middleware defined later in the stack.
app.use("/api", apiErrorHandler);

function baseUrl(req: Request): string {
	return `${req.protocol}://${req.hostname}`;
}

type SiteOriginReason = "accepted" | "unparseable" | "bad_scheme" | "system_host";

function siteOriginReason(url: URL | null): SiteOriginReason {
	if (!url) return "unparseable";
	if (url.protocol !== "https:") return "bad_scheme";
	if (isSystemHost(url)) return "system_host";
	return "accepted";
}

function isIpHost(hostname: string | undefined): boolean {
	return isIP((hostname ?? "").replace(/^\[|\]$/g, "")) !== 0;
}

function parseUrl(raw: string): URL | null {
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

export function preferredOrigin(req: Request): string {
	const raw: string | undefined = req.get("x-airo-site-origin");
	if (!raw) return baseUrl(req);
	const url: URL | null = parseUrl(raw);
	const reason: SiteOriginReason = siteOriginReason(url);
	const origin: string = url && reason === "accepted" ? url.origin : baseUrl(req);
	const headerIsIp: boolean = url !== null && isIpHost(url.hostname);
	const requestIsIp: boolean = isIpHost(req.hostname);
	if (headerIsIp || requestIsIp) {
		const where: string = headerIsIp && requestIsIp ? "both" : headerIsIp ? "header" : "request";
		console.info("ssr.site-origin.ip-literal", `in=${where} reason=${reason}`);
		return origin;
	}
	console.info("ssr.site-origin.observed", `requestOrigin=${baseUrl(req)} preferredOrigin=${origin} reason=${reason}`);
	return origin;
}

/**
 * Absolute URL of the platform's default social image. dev-supervisor sets this
 * header (after stripping any client copy) only when the app has a usable logo
 * or hero image; render() uses it for og:image/twitter:image the page omits.
 */
export function socialPreviewImageUrl(req: Request): string | undefined {
	const path: string | undefined = req.get("x-airo-media-social-preview");
	if (!path || !/^\/airo-assets\/images\/[\w/-]+$/.test(path)) return undefined;
	return `${req.protocol}://${req.hostname}${path}`;
}

function escapeXml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
	);
}

app.get("/robots.txt", (req, res) => {
	if (isSystemHost(req)) {
		res
			.type("text/plain")
			.set("Cache-Control", "public, max-age=60, must-revalidate").set("Vary", "Host")
			.send("User-agent: *\nDisallow: /\n");
		return;
	}
	const base = baseUrl(req);
	const body = [
		"User-agent: *",
		"Allow: /",
		"",
		`Sitemap: ${base}/sitemap.xml`,
		"",
	].join("\n");
	res.type("text/plain").set("Cache-Control", "public, max-age=60, must-revalidate").set("Vary", "Host").send(body);
});

app.get("/sitemap.xml", (req, res) => {
	if (isSystemHost(req)) {
		const empty = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>\n`;
		res.type("application/xml").set("Cache-Control", "public, max-age=60, must-revalidate").set("Vary", "Host").send(empty);
		return;
	}
	const base = baseUrl(req);
	const urls = seoRoutes
		.filter((r) => typeof r.path === "string" && r.path.startsWith("/"))
		.map((r) => {
			const loc = `${base}${r.path}`;
			const parts = [`    <loc>${escapeXml(loc)}</loc>`];
			if (r.lastmod) parts.push(`    <lastmod>${escapeXml(r.lastmod)}</lastmod>`);
			if (r.changefreq) parts.push(`    <changefreq>${r.changefreq}</changefreq>`);
			if (r.priority !== undefined)
				parts.push(`    <priority>${r.priority.toFixed(1)}</priority>`);
			return `  <url>\n${parts.join("\n")}\n  </url>`;
		})
		.join("\n");
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
	res.type("application/xml").set("Cache-Control", "public, max-age=60, must-revalidate").set("Vary", "Host").send(body);
});

app.get("/llms.txt", llmsTxtHandler);

if (import.meta.env.PROD) {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const clientDir = join(__dirname, "client");
	const adSenseRuntimeConfig = loadAdSenseRuntimeConfig(__dirname);
	const indexNowKey = loadIndexNowKey(__dirname);

	registerAdSenseTextRoutes(app, adSenseRuntimeConfig);

	if (indexNowKey !== null) {
		app.get(`/${indexNowKey}.txt`, (_req, res) => {
			res.type("text/plain").set("Cache-Control", "public, max-age=86400").send(indexNowKey);
		});
	}

	app.use(
		express.static(clientDir, {
			index: false,
			setHeaders(res, filePath) {
				res.set(
					"Cache-Control",
					filePath.includes("/assets/")
						? "public, max-age=31536000, immutable"
						: "no-cache",
				);
			},
		}),
	);

	app.use((_req, res, next) => {
		res.set("Cache-Control", "no-cache");
		next();
	});

	let template: string;
	try {
		template = readFileSync(join(clientDir, "index.html"), "utf-8");
	} catch (err) {
		console.error("ssr.template.load-failed", {
			path: join(clientDir, "index.html"),
			error: err instanceof Error ? err.message : String(err),
		});
		process.exit(1);
	}
	if (!template.includes("<!--app-head-->") || !template.includes("<!--app-html-->")) {
		// Fail fast at boot, same as a template load failure above: without
		// markers, every .replace() call on the render path is a no-op and we
		// would serve a shell with no <head> content and no rendered body on
		// every request. Preferring process.exit over a degraded mode ensures
		// an operator notices and fixes the build rather than serving broken
		// SEO-invisible pages indefinitely.
		console.error("ssr.template.markers-missing", {
			hasHead: template.includes("<!--app-head-->"),
			hasHtml: template.includes("<!--app-html-->"),
		});
		process.exit(1);
	}
	const fallbackShell = template
		.replace("<!--app-head-->", "")
		.replace("<!--app-html-->", "");

	// Resolve the SSR module once into a stable render function. A failed
	// load is unrecoverable at runtime - exiting lets the container
	// scheduler restart with a clean slate rather than leaving the server
	// to serve silent 503s indefinitely against a single startup log.
	let renderFn: ((url: string, siteOrigin?: string, socialPreviewImage?: string) => Promise<SsrRenderResult>) | null = null;
	const SSR_MODULE_LOAD_TIMEOUT_MS = 30_000;
	const loadTimeout = setTimeout(() => {
		if (renderFn !== null) return;
		console.error("ssr.module.load-timeout", {
			timeoutMs: SSR_MODULE_LOAD_TIMEOUT_MS,
		});
		process.exit(1);
	}, SSR_MODULE_LOAD_TIMEOUT_MS);
	loadTimeout.unref();
	import("../entry-server").then(
		(mod) => {
			clearTimeout(loadTimeout);
			renderFn = mod.render;
		},
		(err) => {
			clearTimeout(loadTimeout);
			console.error("ssr.module.load-failed", {
				error: err instanceof Error ? err.stack : String(err),
			});
			process.exit(1);
		},
	);

	app.get(/.*/, async (req, res, next) => {
		if (req.method !== "GET") return next();
		if (req.path.startsWith("/api")) return next();
		if (extname(req.path)) return next();
		const sendFallback = () =>
			res
				.status(503)
				.set("Content-Type", "text/html; charset=utf-8")
				.set("Cache-Control", "no-store")
				.send(fallbackShell);
		if (renderFn === null) {
			// Module not yet resolved; fall back without logging to avoid startup
			// noise before the first render is even possible. A terminal load
			// failure (import reject or 30s timeout) process.exit(1)s from the
			// loader above, so this branch is only the brief warmup window.
			return sendFallback();
		}
		try {
			const socialPreviewImage: string | undefined = socialPreviewImageUrl(req);
			const result = await renderFn(
				req.url,
				`${req.protocol}://${req.hostname}`,
				socialPreviewImage,
			);
			if (result.redirect) {
				// Redirect thrown from a loader/action surfaces as a Response.
				// Forward it so the browser actually navigates to the new URL
				// instead of seeing an empty shell with a stale status.
				res.redirect(result.status, result.redirect);
				return;
			}
			if (!result.html) {
				// A non-redirect Response was thrown from a loader (e.g.
				// `throw new Response(null, { status: 404 })`). renderToString
				// produced no markup, so we have a real status but no body.
				// Log so the case is observable in ops dashboards, and mark
				// no-store so CDNs don't cache an empty page as a valid hit.
				// User-visible 404 / error pages should come from a route
				// errorElement, not from this fallback path.
				console.error("ssr.render.error-response", {
					route: routeLabel(req),
					status: result.status,
				});
				res
					.status(result.status)
					.set("Content-Type", "text/html; charset=utf-8")
					.set("Cache-Control", "no-store")
					.send(fallbackShell);
				return;
			}
			preferredOrigin(req);
			// Per-host SEO injection. System URLs get a noindex meta so
			// crawlers drop them from the index over time; customer-attached
			// hosts get a self-canonical link so search engines treat them
			// as authoritative for the rendered content.
			const seoHead = isSystemHost(req)
				? `<meta name="robots" content="noindex,nofollow">`
				: `<link rel="canonical" href="${escapeXml(`${req.protocol}://${req.hostname}${req.path}`)}">`;
			// Function replacements disable String.replace's $-special sequences
			// ($&, $', $`, $$) so user-authored titles / JSON-LD like
			// "Save $& today" insert literally instead of being interpolated.
			const out = renderSsrDocument(
				template,
				{ ...result, head: seoHead + result.head },
				adSenseRuntimeConfig,
			);
			res
				.status(result.status)
				.set("Content-Type", "text/html; charset=utf-8")
				.set("Cache-Control", "no-cache")
				.send(out);
		} catch (err) {
			// 503 surfaces the failure in CDN/monitoring without caching a broken
			// page as success. console.error (not warn) puts it at the right log
			// level for the observability pipeline to alert on.
			console.error("ssr.render.failed", {
					route: routeLabel(req),
					// The stack is dropped even though React annotates it with the failing
					// component tree. A route component or loader throws messages it builds
					// itself, so a thrown value can quote a query parameter or a submitted
					// field, and the message is embedded in the stack. The component tree is
					// not worth sending request data to a shared log.
					error: toLogError(err),
				});
			sendFallback();
		}
	});

	// Last in the stack, so it sees any error the routes above pass on.
	app.use(finalErrorHandler);

	const shutdown = async (signal: string) => {
		console.log(`Got ${signal}, shutting down gracefully...`);
		// Scope the ERR_MODULE_NOT_FOUND suppression to the import() only.
		// A closeConnection() failure that happens to carry the same code
		// (unlikely but possible for wrapped errors) must not be silently
		// swallowed - it indicates a real db-close failure worth logging.
		let mod: { closeConnection?: () => Promise<void> | void } | null = null;
		try {
			const dbClient = "./db/client" + ".js";
			// Source-literal optional module path; no request, environment, or user input reaches import().
			// eslint-disable-next-line no-unsanitized/method
			mod = await import(/* @vite-ignore */ dbClient);
		} catch (error: unknown) {
			const code = (error as { code?: string } | null)?.code;
			if (code !== "ERR_MODULE_NOT_FOUND") {
				console.error("ssr.shutdown.db-import-failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (mod && typeof mod.closeConnection === "function") {
			try {
				await mod.closeConnection();
				console.log("Database connections closed");
			} catch (error: unknown) {
				console.error("ssr.shutdown.db-close-failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		process.exit(0);
	};

	(["SIGTERM", "SIGINT"] as const).forEach((signal) => {
		process.once(signal, () => {
			void shutdown(signal);
		});
	});

	const rawPort = process.env.PORT || "3000";
	const port = parseInt(rawPort, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		// parseInt("abc") returns NaN; passing that to app.listen throws
		// synchronously before the server.on("error") handler below can catch
		// it. Fail fast with an actionable log rather than a cryptic crash.
		console.error("ssr.server.invalid-port", { rawPort });
		process.exit(1);
	}
	const host = process.env.HOST || "0.0.0.0";
	const server = app.listen(port, host, () => {
		console.log(`Server listening on http://${host}:${port}`);
	});
	server.on("error", (err: NodeJS.ErrnoException) => {
		console.error("ssr.server.listen-failed", {
			port,
			host,
			code: err.code,
			error: err.message,
		});
		process.exit(1);
	});
}

export default app;
