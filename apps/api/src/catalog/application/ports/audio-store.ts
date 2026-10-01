/** Object store for downloaded audio (MinIO / any S3-compatible server). Audio is cached here so Telegram is hit once per track. */
export interface AudioStore {
  /** Object size, or null if it does not exist. Throws when the store itself is unreachable. */
  stat(key: string): Promise<{ size: number } | null>;
  /** Streams the object from `offset`. */
  open(key: string, opts?: { offset?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  /** Uploads a stream (multipart, never buffers the whole file). Rejects if the stream errors: no partial object is created. */
  put(key: string, data: NodeJS.ReadableStream, size?: number): Promise<void>;
  remove(key: string): Promise<void>;
  /** Connectivity + permissions check: creates the bucket if missing, writes/reads/deletes a tiny object. */
  ping(): Promise<void>;
  usage(limit?: number): Promise<{ objects: number; bytes: number; truncated: boolean }>;
}

export interface AudioStoreSource {
  /** null = cache disabled/not configured: everything must keep working straight from Telegram. */
  current(): Promise<AudioStore | null>;
}
