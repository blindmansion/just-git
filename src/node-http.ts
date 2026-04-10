/** Node.js `http.IncomingMessage`-compatible request interface. */
export interface NodeHttpRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: string, listener: (...args: any[]) => void): any;
}

/** Node.js `http.ServerResponse`-compatible response interface. */
export interface NodeHttpResponse {
	writeHead(statusCode: number, headers?: Record<string, string | string[]>): any;
	write(chunk: any): any;
	end(data?: string): any;
}
