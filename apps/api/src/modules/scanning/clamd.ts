import net from 'node:net';
import { once } from 'node:events';
import type { Readable } from 'node:stream';

/**
 * A client for clamd's INSTREAM command.
 *
 * The protocol is small enough to own rather than depend on: send
 * `zINSTREAM\0`, then the file in chunks — each prefixed with its length as a
 * four-byte big-endian integer — then a zero-length chunk. clamd answers with
 * one line and closes the connection.
 *
 * Anything but a clear "OK" or "FOUND" is an error, never a clean verdict: a
 * scanner that could not scan must not be mistaken for one that found nothing.
 */

export type ScanVerdict = { clean: true } | { clean: false; signature: string };

export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerError';
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

const MAX_CHUNK = 64 * 1024;

export function parseReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0/g, '').trim();

  if (text === 'stream: OK') return { clean: true };

  const found = text.match(/^stream: (.+) FOUND$/);
  if (found) return { clean: false, signature: found[1]! };

  throw new ScannerError(`The scanner could not scan the file: ${text || 'no reply'}`);
}

function exchange(
  options: ClamdOptions,
  send: (socket: net.Socket) => Promise<void>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const received: Buffer[] = [];
    let settled = false;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      outcome();
    };

    socket.setTimeout(options.timeoutMs ?? 60_000, () =>
      finish(() => reject(new ScannerError('The scanner did not answer in time'))),
    );

    socket.on('data', (chunk) => received.push(chunk));

    socket.on('end', () => finish(() => resolve(Buffer.concat(received).toString('utf8'))));

    socket.on('error', (error) =>
      finish(() => {
        // clamd may answer and close while the file is still being sent — for
        // a file over its size limit. The answer is what matters.
        if (received.length > 0) resolve(Buffer.concat(received).toString('utf8'));
        else reject(new ScannerError(`The scanner is unreachable: ${error.message}`));
      }),
    );

    socket.on('connect', () => {
      send(socket).catch((error: unknown) =>
        finish(() =>
          reject(error instanceof ScannerError ? error : new ScannerError(String(error))),
        ),
      );
    });
  });
}

async function write(socket: net.Socket, data: Buffer): Promise<void> {
  if (!socket.write(data)) await once(socket, 'drain');
}

export async function scanStream(stream: Readable, options: ClamdOptions): Promise<ScanVerdict> {
  const reply = await exchange(options, async (socket) => {
    await write(socket, Buffer.from('zINSTREAM\0'));

    for await (const piece of stream) {
      const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);

      for (let offset = 0; offset < buffer.length; offset += MAX_CHUNK) {
        const chunk = buffer.subarray(offset, offset + MAX_CHUNK);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        await write(socket, Buffer.concat([length, chunk]));
      }
    }

    await write(socket, Buffer.alloc(4));
  });

  return parseReply(reply);
}

/** Whether clamd is up and has loaded its signatures. */
export async function ping(options: ClamdOptions): Promise<boolean> {
  try {
    const reply = await exchange({ ...options, timeoutMs: options.timeoutMs ?? 5_000 }, (socket) =>
      write(socket, Buffer.from('zPING\0')),
    );
    return reply.replace(/\0/g, '').trim() === 'PONG';
  } catch {
    return false;
  }
}
