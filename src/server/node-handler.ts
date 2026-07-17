import { nodeRequestToWebRequest, pipeWebResponseToNode } from "../node-http.ts";
import type { NodeHttpRequest, NodeHttpResponse } from "./types.ts";

type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Adapt a Fetch API handler to a Node.js `http.createServer` callback.
 */
export function createNodeHandler(
	fetchHandler: FetchHandler,
): (req: NodeHttpRequest, res: NodeHttpResponse) => void {
	return (req, res) => {
		void handleNodeRequest(fetchHandler, req, res);
	};
}

async function handleNodeRequest(
	fetchHandler: FetchHandler,
	req: NodeHttpRequest,
	res: NodeHttpResponse,
): Promise<void> {
	let bridge: ReturnType<typeof nodeRequestToWebRequest> | undefined;
	try {
		bridge = nodeRequestToWebRequest(req);
		const response = await fetchHandler(bridge.request);
		const cleanupNow = deferRequestCleanupUntilResponseFinishes(bridge.cleanup, res);
		try {
			await pipeWebResponseToNode(response, res);
			if (!cleanupNow) bridge.cleanup();
		} catch (error) {
			cleanupNow?.();
			throw error;
		}
	} catch {
		bridge?.cleanup();
		try {
			res.writeHead(500);
			res.end("Internal Server Error");
		} catch {
			// Headers were already sent or the socket disconnected.
		}
	}
}

function deferRequestCleanupUntilResponseFinishes(
	cleanupRequest: () => void,
	res: NodeHttpResponse,
): (() => void) | undefined {
	if (!res.once) return undefined;
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		res.off?.("finish", cleanup);
		res.off?.("close", cleanup);
		cleanupRequest();
	};
	res.once("finish", cleanup);
	res.once("close", cleanup);
	return cleanup;
}
