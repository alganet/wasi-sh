export const HEADER_BYTES: number;

export function createStdinRing(dataBytes?: number): SharedArrayBuffer;

export class RingOverflowError extends Error {
  constructor(requested: number, free: number);
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
}

/** The WasiShim `input` contract (see shim.d.mts). */
export interface RingInput {
  pollReadable(ms: number): boolean;
  read(max: number): Uint8Array;
  readBlocking(max: number): Uint8Array;
  wait(ms: number): void;
  closed(): boolean;
}

export class RingReader {
  constructor(sab: SharedArrayBuffer);
  readonly readable: boolean;
  readonly ended: boolean;
  readonly closed: boolean;
  pollReadable(ms: number): boolean;
  read(max: number): Uint8Array;
  readBlocking(max: number): Uint8Array;
  wait(ms: number): void;
  toInput(): RingInput;
}
