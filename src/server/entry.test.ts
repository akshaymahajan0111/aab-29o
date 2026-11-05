import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	apiErrorHandler,
	finalErrorHandler,
	renderSsrDocument,
	registerAdSenseTextRoutes,
	routeLabel,
	toLogError,
} from "./entry";

const publisherId = "ca-pub-1234567890123456";
const canonicalScript = `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}" crossorigin="anonymous"></script>`;

async function withServer<T>(
	app: express.Express,
	run: (baseUrl: string) => Promise<T>,
): Promise<T> {
	let server: Server | null = null;
	try {
		server = await new Promise<Server>((resolve) => {
			const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Expected TCP listener");
		}
		return await run(`http://127.0.0.1:${address.port}`);
	} finally {
		if (server) {
			const listeningServer = server;
			await new Promise<void>((resolve, reject) => {
				listeningServer.close((error) => (error ? reject(error) : resolve()));
			});
		}
	}
}

describe("entry AdSense text routes", () => {
	it("serves enabled ads.txt as text/plain with no-cache", async () => {
		const app = express();
		registerAdSenseTextRoutes(app, {
			publisherId: null,
			scriptHtml: "",
			adsTxt: "google.com, pub-123, DIRECT, f08c47fec0942fa0",
			appAdsTxt: null,
		});

		await withServer(app, async (baseUrl) => {
			const response = await fetch(`${baseUrl}/ads.txt`);

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/plain");
			expect(response.headers.get("cache-control")).toBe("no-cache");
			expect(await response.text()).toBe("google.com, pub-123, DIRECT, f08c47fec0942fa0");
		});
	});

	it("serves enabled app-ads.txt as text/plain with no-cache", async () => {
		const app = express();
		registerAdSenseTextRoutes(app, {
			publisherId: null,
			scriptHtml: "",
			adsTxt: null,
			appAdsTxt: "google.com, pub-456, DIRECT, f08c47fec0942fa0",
		});

		await withServer(app, async (baseUrl) => {
			const response = await fetch(`${baseUrl}/app-ads.txt`);

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/plain");
			expect(response.headers.get("cache-control")).toBe("no-cache");
			expect(await response.text()).toBe("google.com, pub-456, DIRECT, f08c47fec0942fa0");
		});
	});

	it("returns 404 for disabled AdSense text routes", async () => {
		const app = express();
		registerAdSenseTextRoutes(app, {
			publisherId: null,
			scriptHtml: "",
			adsTxt: null,
			appAdsTxt: null,
		});

		await withServer(app, async (baseUrl) => {
			const adsTxt = await fetch(`${baseUrl}/ads.txt`);
			const appAdsTxt = await fetch(`${baseUrl}/app-ads.txt`);

			expect(adsTxt.status).toBe(404);
			expect(adsTxt.headers.get("content-type")).toContain("text/plain");
			expect(adsTxt.headers.get("cache-control")).toBe("no-cache");
			expect(appAdsTxt.status).toBe(404);
			expect(appAdsTxt.headers.get("content-type")).toContain("text/plain");
			expect(appAdsTxt.headers.get("cache-control")).toBe("no-cache");
		});
	});
});

describe("entry SSR rendering", () => {
	it("appends the canonical AdSense script to existing head output", () => {
		const html = renderSsrDocument(
			"<html><head><!--app-head--></head><body><!--app-html--></body></html>",
			{
				head: "<title>Generated Site</title>",
				html: "<main>Rendered app</main>",
			},
			{
				scriptHtml: canonicalScript,
			},
		);

		expect(html).toContain(`<title>Generated Site</title>\n${canonicalScript}`);
		expect(html).toContain("<main>Rendered app</main>");
		expect(html).not.toContain("<!--app-head-->");
		expect(html).not.toContain("<!--app-html-->");
	});

	it("keeps SSR head output unchanged when AdSense script output is disabled", () => {
		const html = renderSsrDocument(
			"<html><head><!--app-head--></head><body><!--app-html--></body></html>",
			{
				head: "<title>Generated Site</title>",
				html: "<main>Rendered app</main>",
			},
			{
				scriptHtml: "",
			},
		);

		expect(html).toContain("<title>Generated Site</title>");
		expect(html).not.toContain("pagead2.googlesyndication.com");
		expect(html).toContain("<main>Rendered app</main>");
	});
});

// A body whose very first character is invalid JSON, because that is the only
// shape that leaks anything. Measured against this template's pinned
// express 5.2.1 / body-parser 2.2.2: the SyntaxError message quotes the first
// ten characters of the raw body when the body is longer than the quoted
// window, and the whole body when it is shorter. A body that parses for a while
// and fails LATE — an unterminated string, a trailing comma — reports only a
// position and quotes nothing, so a test written with one of those would assert
// nothing at all.
//
// The first field is therefore the one at risk, and it is the SSN here so that
// the ten-character window carries a value (`ssn=123-45`) rather than only a
// field name. With `email` first the window is `email=vict`, and the single
// fragment still inside it is the word "email".
const PII_BODY = "ssn=123-45-6789&email=victim@example.com";
const PII_FRAGMENTS = ["ssn", "123-45", "email", "victim", "example.com"];

function expectNoBodyExcerpt(serialized: string): void {
	for (const fragment of PII_FRAGMENTS) {
		expect(serialized).not.toContain(fragment);
	}
}

describe("toLogError", () => {
	it("keeps the error class, body-parser type, code and status", () => {
		const err = Object.assign(new SyntaxError("Unexpected token 'e', \"email=vict\"..."), {
			type: "entity.parse.failed",
			status: 400,
			code: "ERR_BAD_REQUEST",
		});

		const { frames, ...named } = toLogError(err);
		expect(named).toEqual({
			name: "SyntaxError",
			type: "entity.parse.failed",
			status: 400,
			code: "ERR_BAD_REQUEST",
		});
		expect(frames).toBeDefined();
	});

	it("drops the message, which carries the request body", () => {
		const err = new SyntaxError(`Unexpected token 'e', "${PII_BODY}"... is not valid JSON`);

		expectNoBodyExcerpt(JSON.stringify(toLogError(err)));
	});

	it("keeps the frames, so the failing line is still named", () => {
		const err = new TypeError("services.map is not a function");

		const frames = toLogError(err).frames as string[];

		expect(frames.length).toBeGreaterThan(0);
		// A frame names this file and the line the error was constructed on. The
		// message is not part of any of them.
		expect(frames[0]).toContain("entry.test.ts");
		expect(frames.join("\n")).not.toContain("services.map");
	});

	it("keeps no frame a message shaped like one could have supplied", () => {
		// What a visitor can reach: body-parser quotes a prefix of the raw body, so
		// the message is where a forged frame would arrive. Removing the message by
		// its own length is what rules this out; splitting on the first frame-shaped
		// line would keep everything after the forgery.
		const err = new SyntaxError(
			`Unexpected token 'e', "x"\n    at forged (${PII_BODY}:1:1)\n    at next (x:1:1)`,
		);

		const frames = toLogError(err).frames as string[];

		expect(frames.join("\n")).not.toContain("forged");
		expectNoBodyExcerpt(JSON.stringify(toLogError(err)));
	});

	it("reports no frames when the stack does not begin with its own message", () => {
		// A library that reassigns `stack`, or renames the error after constructing
		// it, leaves a string this cannot cut the message out of. Logging nothing is
		// the only safe reading of it.
		const err = new Error("boom");
		err.stack = `Error: a different message\n    at somewhere (${PII_BODY}:1:1)`;

		expect(toLogError(err)).toEqual({ name: "Error" });
	});

	it("reports no frames for an error carrying no stack, keeping the rest", () => {
		// `stack` is a V8 extension, not part of the Error contract. A cross-realm
		// error, or one built by a library that never set it, arrives without one.
		// The other fields are still worth logging.
		const err = new RangeError("boom");
		delete (err as { stack?: string }).stack;

		expect(toLogError(err)).toEqual({ name: "RangeError" });
	});

	it("caps the frames rather than logging a whole stack", () => {
		const deep = (depth: number): Error =>
			depth === 0 ? new RangeError("bottom") : deep(depth - 1);

		expect((toLogError(deep(20)).frames as string[]).length).toBe(5);
	});

	it("names the type of a non-Error throw", () => {
		expect(toLogError("boom")).toEqual({ name: "string" });
		expect(toLogError(null)).toEqual({ name: "object" });
	});
});

describe("entry error handlers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs no request body excerpt when /api receives malformed JSON", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		app.use(express.json());
		app.post("/api/contact", (_req, res) => res.json({ ok: true }));
		app.use("/api", apiErrorHandler);

		const response = await withServer(app, (baseUrl) =>
			fetch(`${baseUrl}/api/contact?email=victim@example.com`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: PII_BODY,
			}),
		);

		// The response contract is unchanged: /api answered 500 JSON before.
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({ error: "Internal server error" });

		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [event, fields] = errorSpy.mock.calls[0]!;
		expect(event).toBe("ssr.api.error");
		expectNoBodyExcerpt(JSON.stringify(fields));
		// express.json() rejects the body before Express matches a route, so there is
		// no template to name and the placeholder stands in. The request target is not
		// a fallback: "/api/contact" would be a path this visitor chose.
		expect(fields).toMatchObject({ route: "(unrouted)" });
		expect(JSON.stringify(fields)).not.toContain("?");
		expect(fields).not.toHaveProperty("url");
		expect(fields).not.toHaveProperty("path");
	});

	it("still has a body excerpt for the shaper to drop", async () => {
		// The premise every expectNoBodyExcerpt assertion rests on. If a dependency
		// bump stopped quoting the body, those assertions would all keep passing
		// while asserting nothing, and this is what fails instead.
		const captured: Error[] = [];
		const app = express();
		app.use(express.json());
		app.post("/api/contact", (_req, res) => res.json({ ok: true }));
		app.use(
			(
				err: Error,
				_req: express.Request,
				res: express.Response,
				_next: express.NextFunction,
			): void => {
				captured.push(err);
				res.status(500).end();
			},
		);

		await withServer(app, (baseUrl) =>
			fetch(`${baseUrl}/api/contact`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: PII_BODY,
			}),
		);

		expect(captured).toHaveLength(1);
		// A value from the body, not just a field name: the window is `ssn=123-45`.
		expect(captured[0]!.message).toContain("123-45");
		// And the shaper takes it back out.
		expectNoBodyExcerpt(JSON.stringify(toLogError(captured[0]!)));
	});

	it("logs the path without the query string on a non-/api request", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		app.use(express.json());
		app.post("/signup", (_req, res) => res.json({ ok: true }));
		app.use(finalErrorHandler);

		const response = await withServer(app, (baseUrl) =>
			fetch(`${baseUrl}/signup?reset_token=abc123`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: PII_BODY,
			}),
		);

		// Express's default handler would have chosen 400 for a parse failure.
		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).not.toContain("SyntaxError");
		expectNoBodyExcerpt(text);

		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [event, fields] = errorSpy.mock.calls[0]!;
		expect(event).toBe("ssr.request.failed");
		expect(fields).toMatchObject({ route: "(unrouted)" });
		expectNoBodyExcerpt(JSON.stringify(fields));
		expect(JSON.stringify(fields)).not.toContain("reset_token");
		expect(fields).not.toHaveProperty("path");
	});

	it("names the route template, not the address a visitor put in the path", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		app.post("/signup/:token", () => {
			throw new Error("confirmation failed");
		});
		app.use(finalErrorHandler);

		const response = await withServer(app, (baseUrl) =>
			fetch(`${baseUrl}/signup/victim@example.com`, { method: "POST" }),
		);

		expect(response.status).toBe(500);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [event, fields] = errorSpy.mock.calls[0]!;
		expect(event).toBe("ssr.request.failed");
		expect(fields).toMatchObject({ route: "/signup/:token" });
		// The segment the visitor supplied is the whole point: a path can hold an
		// address even when there is no query string to drop.
		expectNoBodyExcerpt(JSON.stringify(fields));
	});

	it("names the route template, not the customer id bound to it, on /api", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		app.get("/api/bookings/:id", () => {
			throw new Error("lookup failed");
		});
		app.use("/api", apiErrorHandler);

		const response = await withServer(app, (baseUrl) =>
			fetch(`${baseUrl}/api/bookings/BOOKED-4821`),
		);

		expect(response.status).toBe(500);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [event, fields] = errorSpy.mock.calls[0]!;
		expect(event).toBe("ssr.api.error");
		// Registered on the app rather than a mounted router, so the template already
		// carries the /api prefix and nothing has to be reconstructed from req.baseUrl.
		expect(fields).toMatchObject({ route: "/api/bookings/:id" });
		expect(JSON.stringify(fields)).not.toContain("BOOKED-4821");
	});

	it("names the SSR catch-all by its pattern", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		// The shape the SSR route is registered with in this file.
		app.get(/.*/, () => {
			throw new Error("render failed");
		});
		app.use(finalErrorHandler);

		const response = await withServer(app, (baseUrl) =>
			fetch(`${baseUrl}/order/victim@example.com`),
		);

		expect(response.status).toBe(500);
		const [, fields] = errorSpy.mock.calls[0]!;
		expect(fields).toMatchObject({ route: ".*" });
		expectNoBodyExcerpt(JSON.stringify(fields));
	});

	it("keeps a 500 for an error that carries no HTTP status", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const app = express();
		app.get("/boom", () => {
			throw new TypeError("cannot read properties of undefined");
		});
		app.use(finalErrorHandler);

		const response = await withServer(app, (baseUrl) => fetch(`${baseUrl}/boom`));

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("TypeError");
	});

	it("aborts the response rather than handing the raw error on once it has started", async () => {
		const logged: unknown[][] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]): void => {
			logged.push(args);
		});
		const app = express();
		let forwarded = false;
		app.get("/partial", (_req, res, next) => {
			res.status(200).write("partial");
			next(new Error(`late failure for ${PII_BODY}`));
		});
		app.use(finalErrorHandler);
		// Stands in for Express's built-in final handler, which is what actually runs in
		// production and writes the raw stack to stderr. Reaching anything here at all
		// means the unsanitized error was forwarded.
		app.use(((_err, _req, res2, _next): void => {
			forwarded = true;
			res2.end();
		}) as express.ErrorRequestHandler);

		const outcome: string = await withServer(
			app,
			(baseUrl: string): Promise<string> =>
				// Destroying a started response surfaces as a transport error. Both the shape and
				// the stage vary by platform — the headers may or may not reach the client before
				// the socket goes away — so record only whether the transfer finished. That is the
				// part that separates destroy() from a clean end(), and it holds either way.
				fetch(`${baseUrl}/partial`)
					.then((r: Response): Promise<string> => r.text())
					.then((): string => "completed")
					.catch((): string => "aborted"),
		);

		// What the sanitized-log checks below rest on. Replacing destroy() with end() answers
		// a complete 200 carrying "partial", and every other expectation here still passes.
		expect(outcome).toBe("aborted");
		expect(forwarded).toBe(false);
		// Without these the PII loop is vacuous: JSON.stringify([]) holds no fragment, so
		// dropping the log line altogether would read as a pass.
		expect(logged).toHaveLength(1);
		expect(logged[0]?.[0]).toBe("ssr.request.failed");
		const serialized: string = JSON.stringify(logged);
		for (const fragment of PII_FRAGMENTS) {
			expect(serialized).not.toContain(fragment);
		}
	});
});

describe("routeLabel", () => {
	/** Only the field routeLabel reads; a real Request carries far more. */
	function reqWith(route: unknown): Parameters<typeof routeLabel>[0] {
		return { route } as unknown as Parameters<typeof routeLabel>[0];
	}

	it("reports the placeholder when no route matched", () => {
		expect(routeLabel(reqWith(undefined))).toBe("(unrouted)");
		expect(routeLabel(reqWith(null))).toBe("(unrouted)");
	});

	it("reports the placeholder for a route registered with an array of paths", () => {
		// Express allows app.get(["/book", "/book/:id"], ...), which has no single
		// template. Returning either one would misreport the request.
		expect(routeLabel(reqWith({ path: ["/book", "/book/:id"] }))).toBe("(unrouted)");
	});

	it("reports a string template and a RegExp pattern unchanged", () => {
		expect(routeLabel(reqWith({ path: "/api/bookings/:id" }))).toBe("/api/bookings/:id");
		expect(routeLabel(reqWith({ path: /.*/ }))).toBe(".*");
	});
});
