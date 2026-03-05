/**
 * pi-remote: start pi inside a PTY and expose it over WebSocket for remote
 * browser/mobile access.
 *
 * Usage:
 *   import { startRemote } from "@mariozechner/pi-remote";
 *   await startRemote({ piPath: "/path/to/pi", args: ["-c"] });
 */

import { killPty, spawnInPty } from "./pty.js";
import { ACCESS_TOKEN, getLocalUrl, getPort, startServer } from "./server.js";
import { setupTerminalWebSocket } from "./ws.js";

export { ACCESS_TOKEN, getLocalUrl, getPort };

export interface RemoteOptions {
	/**
	 * Path to the pi binary (or any executable to run in the PTY).
	 * When omitted, pi-remote tries to locate `pi` on PATH.
	 */
	piPath?: string;
	/** Extra arguments forwarded to pi (e.g. ["-c", "--model", "sonnet"]) */
	args?: string[];
	/** Working directory for pi. Default: process.cwd() */
	cwd?: string;
	/** Environment variables forwarded to pi. Default: process.env */
	env?: Record<string, string>;
}

/**
 * Resolve the `pi` binary path.
 * Tries options.piPath first, then searches PATH.
 */
async function resolvePiPath(piPath?: string): Promise<string> {
	if (piPath) return piPath;

	const { execSync } = await import("node:child_process");
	for (const cmd of ["which pi", "command -v pi"]) {
		try {
			const result = execSync(cmd, {
				encoding: "utf-8" as const,
				env: process.env,
			}).trim();
			if (result && !result.includes("\n")) return result;
		} catch {
			// try next
		}
	}
	throw new Error('Could not find "pi" binary. Pass piPath explicitly or ensure pi is on PATH.');
}

/**
 * Start a remote pi session:
 *  1. Spawn pi inside a PTY
 *  2. Start the HTTP server (static web UI + /api/local-url)
 *  3. Attach the WebSocket terminal bridge
 *
 * Returns a cleanup function that kills the PTY and stops the server.
 */
export async function startRemote(options: RemoteOptions = {}): Promise<() => void> {
	const piPath = await resolvePiPath(options.piPath);

	// Start HTTP server first (so the port is known before printing the URL)
	const httpServer = await startServer();
	setupTerminalWebSocket(httpServer);

	const url = getLocalUrl();
	const localUrl = `http://127.0.0.1:${getPort()}`;

	// Print URL and QR code to stderr BEFORE pi starts
	process.stderr.write(`\n\x1b[1;36m🌐 Remote Access\x1b[0m\n`);
	process.stderr.write(`  Local:  ${localUrl}\n`);
	process.stderr.write(`  Remote: ${url}\n\n`);

	// Generate QR code in terminal
	try {
		const QRCode = await import("qrcode");
		const qr = await QRCode.toString(url, { type: "terminal", small: true });
		process.stderr.write(qr);
		process.stderr.write("\n");
	} catch {
		// qrcode module not available, skip QR
	}

	// Spawn pi in the PTY with local terminal attached
	// Use actual terminal size if available
	const cols = process.stdout.columns || 120;
	const rows = process.stdout.rows || 30;

	await spawnInPty({
		command: piPath,
		args: options.args ?? [],
		cwd: options.cwd ?? process.cwd(),
		env: (options.env ?? process.env) as Record<string, string>,
		cols,
		rows,
		attachLocal: true,
	});

	// Register cleanup
	const cleanup = (): void => {
		killPty();
		httpServer.close();
	};

	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	return cleanup;
}
