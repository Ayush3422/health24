import net from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReply, ping, scanStream, ScannerError } from './clamd';

/**
 * The INSTREAM protocol against a stand-in for clamd, so the framing is
 * checked byte for byte without a real scanner. The scanning suite runs the
 * same client against ClamAV itself.
 */

type FakeClamd = { port: number; received: () => Buffer; close: () => Promise<void> };

/** Reads one INSTREAM request, then answers with `reply` — or closes without answering. */
function fakeClamd(reply: string | null): Promise<FakeClamd> {
  let payload = Buffer.alloc(0);

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.subarray(0, 6).toString() === 'zPING\0') {
        socket.end('PONG\0');
        return;
      }

      const prefix = 'zINSTREAM\0';
      if (buffer.length < prefix.length) return;
      expect(buffer.subarray(0, prefix.length).toString()).toBe(prefix);

      const pieces: Buffer[] = [];
      let offset = prefix.length;

      while (offset + 4 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);

        if (length === 0) {
          payload = Buffer.concat(pieces);
          if (reply === null) socket.destroy();
          else socket.end(reply);
          return;
        }

        if (offset + 4 + length > buffer.length) return;
        pieces.push(buffer.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received: () => payload,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('clamd client', () => {
  let fake: FakeClamd | null = null;

  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  const options = (port: number) => ({ host: '127.0.0.1', port, timeoutMs: 2_000 });

  it('sends the file in length-prefixed chunks and reads a clean verdict', async () => {
    fake = await fakeClamd('stream: OK\0');
    const file = Buffer.concat([Buffer.from('lab report '), Buffer.alloc(200_000, 7)]);

    const verdict = await scanStream(
      Readable.from([file.subarray(0, 11), file.subarray(11)]),
      options(fake.port),
    );

    expect(verdict).toEqual({ clean: true });
    expect(fake.received().equals(file)).toBe(true);
  });

  it('reads an infected verdict with its signature', async () => {
    fake = await fakeClamd('stream: Win.Test.EICAR_HDB-1 FOUND\0');

    expect(await scanStream(Readable.from([Buffer.from('x')]), options(fake.port))).toEqual({
      clean: false,
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('treats a scanner error as an error, never as clean', async () => {
    fake = await fakeClamd('INSTREAM size limit exceeded. ERROR\0');

    await expect(
      scanStream(Readable.from([Buffer.from('x')]), options(fake.port)),
    ).rejects.toBeInstanceOf(ScannerError);
  });

  it('treats no answer, or no scanner, as an error', async () => {
    fake = await fakeClamd(null);
    await expect(
      scanStream(Readable.from([Buffer.from('x')]), options(fake.port)),
    ).rejects.toBeInstanceOf(ScannerError);

    const closedPort = fake.port;
    await fake.close();
    fake = null;

    await expect(
      scanStream(Readable.from([Buffer.from('x')]), options(closedPort)),
    ).rejects.toBeInstanceOf(ScannerError);
  });

  it('pings', async () => {
    fake = await fakeClamd('stream: OK\0');
    expect(await ping(options(fake.port))).toBe(true);
  });

  it('parses only the replies it knows', () => {
    expect(parseReply('stream: OK')).toEqual({ clean: true });
    expect(() => parseReply('')).toThrow(ScannerError);
    expect(() => parseReply('stream: something odd')).toThrow(ScannerError);
  });
});
