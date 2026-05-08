import { createHash } from 'crypto';
import { createReadStream } from 'fs';

// Stream-hash so the whole file never lands in memory. PDF/AZW3 files can be
// 50MB+; readFileSync blocks the event loop and pressures GC for the load.
export function hashFileSha1(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
  });
}
