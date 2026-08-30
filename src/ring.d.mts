export const HEADER_BYTES: number;

/**
 * A SharedArrayBuffer sized for `dataBytes` of ring capacity — the format both
 * channels use. An inbound host-request ring is not a copy of the stdin one, it
 * is the same ring: a request channel needs head/tail/flags/seq and nothing
 * else, and those are a strict subset of what stdin needs.
 */
export function createRing(dataBytes?: number): SharedArrayBuffer;
/** @deprecated The same function; the format was never stdin's alone. */
export const createStdinRing: typeof createRing;

/**
 * Frame one inbound request as the line /dev/hostreq delivers. Refuses an empty
 * request and one containing a newline — both at the producer, because a guest
 * parked on a request has no write to fail and no `$?` to reach, so an error it
 * could only learn by reading is one it cannot act on.
 */
export function frameRequest(request: string | Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array;

export class RingOverflowError extends Error {
  constructor(requested: number, free: number, channel?: string, sizeOption?: string);
  /** Which channel overflowed — 'stdin' or 'host request'. */
  channel: string;
}

export interface Winsize {
  rows: number;
  cols: number;
}

export class RingWriter {
  /** `channel`/`sizeOption` name this ring in failures; they change nothing else. */
  constructor(sab: SharedArrayBuffer, naming?: { channel?: string; sizeOption?: string });
  readonly capacity: number;
  readonly pending: number;
  readonly ended: boolean;
  /** Append bytes and wake the consumer. Throws RingOverflowError when full. */
  write(bytes: Uint8Array): number;
  /** Signal stdin EOF: the consumer drains, then reads EOF. */
  end(): void;
  /** Post a terminal resize: store geometry, raise pending-winch, and wake. */
  resize(cols: number, rows: number): void;
  /**
   * Post a cooperative interrupt: bump the count and wake. Cancels nothing by
   * itself — delivery is a count whoever is running chose to read at its own
   * safe points. A count rather than a flag so nothing has to consume it, and
   * an interrupt posted while nothing is running cannot cancel the next thing
   * that is.
   */
  interrupt(): void;
}

/** The WasiShim `input` contract (see shim.d.mts). */
export interface RingInput {
  pollReadable(ms: number | null): boolean;
  read(max: number): Uint8Array;
  readBlocking(max: number): Uint8Array;
  wait(ms: number): void;
  closed(): boolean;
  /** Current terminal geometry (0 = unknown). */
  winsize(): Winsize;
  /** Is a resize queued? A peek — takeWinch() is what consumes it. */
  winchPending(): boolean;
  /** Consume the pending-winch flag (true once per resize burst). */
  takeWinch(): boolean;
  /** Cooperative interrupts posted so far. Read once at entry, then compare. */
  interruptCount(): number;
}

export class RingReader {
  constructor(sab: SharedArrayBuffer);
  readonly readable: boolean;
  readonly ended: boolean;
  readonly closed: boolean;
  /** `ms` null parks indefinitely — an untimed guest poll. */
  pollReadable(ms: number | null): boolean;
  read(max: number): Uint8Array;
  readBlocking(max: number): Uint8Array;
  wait(ms: number): void;
  winsize(): Winsize;
  winchPending(): boolean;
  takeWinch(): boolean;
  interruptCount(): number;
  toInput(): RingInput;
}
