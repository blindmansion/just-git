export class RequestLimitError extends Error {
	status = 413;

	constructor(message: string) {
		super(message);
		this.name = "RequestLimitError";
	}
}
