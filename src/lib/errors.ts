export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "REQUEST_ERROR"
  ) {
    super(message);
  }
}
