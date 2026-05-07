const crypto = require('crypto');
const fs = require('fs');

// SHA-1 hash of the file at `filePath`, computed by streaming so the whole
// file never lands in memory. PDF/AZW3 files can be 50MB+; readFileSync
// blocks the event loop and pressures GC for the duration of the load.
function hashFileSha1(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
  });
}

module.exports = { hashFileSha1 };
