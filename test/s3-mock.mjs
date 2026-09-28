/**
 * Local S3-compatible mock for end-to-end testing (no Docker needed).
 *
 * Implements just what lib/s3.js calls — GET/HEAD/PUT on one key with SigV4
 * verification — storing objects in memory, mirroring MinIO's path-style
 * addressing: http://127.0.0.1:<port>/<bucket>/<key>
 *
 * Verifies the Authorization header's signature so the test proves the
 * client really signs correctly (not just that bytes arrive).
 */
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9666);
const ACCESS_KEY = process.env.MOCK_ACCESS_KEY ?? 'test-access-key';
const SECRET_KEY = process.env.MOCK_SECRET_KEY ?? 'test-secret-key';

const objects = new Map(); // key -> { body: Buffer, etag: string, headers: Record<string,string> }

function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function sha256Hex(data) { return createHash('sha256').update(data).digest('hex'); }

function verifySigV4(req, body, canonicalPath) {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return { ok: false, reason: `malformed authorization header: ${auth.slice(0, 80)}` };
  const [, keyId, dateStamp, region, signedHeaders, claimed] = m;
  if (keyId !== ACCESS_KEY) return { ok: false, reason: `wrong access key: ${keyId}` };
  const amzDate = req.headers['x-amz-date'];
  const payloadHash = req.headers['x-amz-content-sha256'] ?? sha256Hex(body);
  const names = signedHeaders.split(';');
  const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`).join('');
  const canonicalRequest = [req.method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), region), 's3'), 'aws4_request');
  const computed = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  if (computed !== claimed) return { ok: false, reason: `signature mismatch (computed ${computed.slice(0, 12)}…, claimed ${claimed.slice(0, 12)}…)` };
  return { ok: true };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const respond = (status, headers, payload) => {
      res.writeHead(status, headers);
      res.end(payload);
    };
    // path-style: /<bucket>/<key...>
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) {
      return respond(404, { 'content-type': 'application/xml' }, '<Error><Code>NoSuchKey</Code><Message>mock: /bucket/key required</Message></Error>');
    }
    const key = segments.slice(1).join('/');
    const verification = verifySigV4(req, body, url.pathname);
    if (!verification.ok) {
      console.log(`  [mock] SIGV4 REJECTED ${req.method} ${path}: ${verification.reason}`);
      return respond(403, { 'content-type': 'application/xml' }, `<Error><Code>SignatureDoesNotMatch</Code><Message>${verification.reason}</Message></Error>`);
    }
    console.log(`  [mock] ${req.method} ${path} (${body.length}b) sig ✓`);
    if (req.method === 'PUT') {
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      const ifMatch = req.headers['if-match'];
      const existing = objects.get(key);
      if (ifMatch !== undefined && (!existing || existing.etag !== ifMatch)) {
        return respond(412, { 'content-type': 'application/xml' }, '<Error><Code>PreconditionFailed</Code><Message>If-Match failed</Message></Error>');
      }
      objects.set(key, { body, etag, headers: { ...req.headers } });
      return respond(200, { etag }, '');
    }
    if (req.method === 'GET') {
      const obj = objects.get(key);
      if (obj === undefined) return respond(404, { 'content-type': 'application/xml' }, '<Error><Code>NoSuchKey</Code><Message>not found</Message></Error>');
      return respond(200, { etag: obj.etag, 'content-type': 'application/json' }, obj.body);
    }
    if (req.method === 'HEAD') {
      const obj = objects.get(key);
      if (obj === undefined) return respond(404, {}, '');
      return respond(200, { etag: obj.etag, 'content-length': String(obj.body.length) }, '');
    }
    return respond(405, { allow: 'GET, HEAD, PUT' }, '');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`s3-mock listening on http://127.0.0.1:${PORT} (access key: ${ACCESS_KEY})`);
});
