export const HEADER_BYTES: number;

export function createStdinRing(dataBytes?: number): SharedArrayBuffer;

export class RingOverflowError extends Error {
  constructor(requested: number, free: number);
}

export interface Winsize {
  rows: number;
  cols: number;
}

export class RingWriter {
  constructor(sab: SharedArrayBuffer);
  readonly capacity: number;
  readonly pending: number;
  readonly ended: boolean;
  /** Append bytes and wake the consumer. Throws RingOverflowError when full. */
  write(bytes: Uint8Array): number;
  /** Signal stdin EOF: the consumer drains, then reads EOF. */
  end(): void;
  /** Post a terminal resize: store geometry, raise pending-winch, and wake. */
  resize(cols: number, rows: number): void;
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
  toInput(): RingInput;
}
