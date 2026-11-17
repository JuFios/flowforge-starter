import { Writable } from 'node:stream';

/** Потік для pino, що розбирає кожен рядок JSON-логу й додає запис у масив. */
export function jsonLineSink(target: Array<Record<string, unknown>>): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        target.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
}
