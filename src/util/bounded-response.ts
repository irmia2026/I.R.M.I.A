/** Streaming response contract shared by update manifests and plugin downloads. */
export interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface ResponseBody {
  getReader(): BodyReader;
  cancel?(reason?: unknown): Promise<void>;
}

export interface BodyResponse {
  readonly headers?: { get(name: string): string | null };
  readonly body?: ResponseBody | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Release a response we will not consume (redirects, errors, rejected lengths). */
export function cancelResponse(response: BodyResponse, reason?: unknown): void {
  try { void response.body?.cancel?.(reason).catch(() => {}); } catch { /* preserve the original failure */ }
}

/**
 * Real fetch responses always use their reader. Check before retaining each chunk,
 * and cancel as soon as the limit is exceeded; never buffer an unbounded body.
 * The absent-body branch supports existing injected, in-memory fetch fixtures.
 */
export async function readBoundedBody(
  response: BodyResponse,
  maxBytes: number,
  tooLarge: (actualBytes: number, declared: boolean) => Error,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers?.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = tooLarge(declared, true);
    cancelResponse(response, error);
    throw error;
  }
  const abortError = (): unknown => signal?.reason ?? Object.assign(new Error('Download aborted'), { name: 'AbortError' });
  const isAborted = (): boolean => signal?.aborted === true;
  if (isAborted()) {
    const error = abortError();
    cancelResponse(response, error);
    throw error;
  }
  if (response.body === null) return new Uint8Array();
  if (response.body === undefined) {
    // Only trusted injected adapters without a streaming body use this compatibility path.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge(bytes.byteLength, false);
    return bytes;
  }

  const reader = response.body.getReader();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = (reason: unknown): void => {
    try { void reader.cancel(reason).catch(() => {}); } catch { /* preserve failure */ }
  };
  const onAbort = (): void => {
    const error = abortError();
    cancel(error);
    rejectAbort?.(error);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // Bound allocation and bookkeeping even if a server produces many tiny chunks.
  const bytes = Buffer.allocUnsafe(maxBytes);
  let total = 0;
  const consume = async (): Promise<Uint8Array> => {
    for (;;) {
      const chunk = await reader.read();
      if (isAborted()) throw abortError();
      if (chunk.done) return bytes.subarray(0, total);
      const value = chunk.value;
      if (value === undefined) continue;
      const next = total + value.byteLength;
      if (next > maxBytes) throw tooLarge(next, false);
      bytes.set(value, total);
      total = next;
    }
  };
  try {
    if (isAborted()) throw abortError();
    return await Promise.race([consume(), aborted]);
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* already cancelled / released */ }
  }
}
