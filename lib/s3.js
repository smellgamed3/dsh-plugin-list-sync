/**
 * Minimal S3-compatible client — AWS SigV4 over node:https, zero dependencies.
 *
 * One transport serves every S3-compatible target (AWS S3, MinIO, RustFS,
 * Cloudflare R2, Aliyun OSS S3 gateway): all of them speak REST + SigV4 with
 * service `s3`; what differs is addressing (path-style vs virtual-host) and
 * region naming, both config knobs here.
 *
 * Scope: GetObject / PutObject / HeadObject on one key. No multipart, no
 * ListObjects — the plugin syncs a single small JSON manifest per profile.
 *
 * Security posture:
 * - Credentials arrive by parameter, never from disk; the caller keeps them
 *   in the DSH credentials service or process env.
 * - https by default; plain http only via explicit allowInsecure opt-in.
 * - Every request carries an AbortSignal and a hard timeout ceiling.
 */
import { createHash, createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** Classified error: `code` is machine-readable for the settings page. */
export class S3Error extends Error {
  constructor(message, code = 'other', status) {
    super(message);
    this.name = 'S3Error';
    this.code = code;
    this.status = status;
  }
}

export function s3ErrorCode(error) {
  if (error instanceof S3Error) return error.code;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const raw = error.cause?.code ?? error.code;
    if (typeof raw === 'string') {
      if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(raw)) return 'network';
      if (raw === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls';
    }
  }
  return 'other';
}

/**
 * Normalize an endpoint into { protocol, host, port } and derive the request
 * authority for signing. Accepts the shapes people actually configure:
 *   https://s3.amazonaws.com
 *   http://127.0.0.1:9000        (MinIO / RustFS)
 *   minio.internal:9000          (scheme defaults to https)
 *   https://account.r2.cloudflarestorage.com
 */
export function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new S3Error('endpoint is empty', 'config');
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new S3Error(`endpoint is not a valid URL: ${raw}`, 'config');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new S3Error('endpoint protocol must be http or https', 'config');
  }
  if (url.username !== '' || url.password !== '') {
    throw new S3Error('endpoint must not embed credentials; configure access keys instead', 'config');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new S3Error('endpoint must not carry a path; set the bucket/prefix separately', 'config');
  }
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
  };
}

/** Bucket names: 3-63 chars, DNS-safe, no leading/trailing dot or hyphen pairs. */
export function validBucketName(bucket) {
  return typeof bucket === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes('..') && !bucket.includes('.-') && !bucket.includes('-.');
}

/** Key prefix: slash-separated segments, no '..' escape. */
export function validPrefix(prefix) {
  if (prefix === undefined || prefix === null || prefix === '') return true;
  return typeof prefix === 'string' && prefix.length <= 512 && !prefix.includes('..') && !prefix.startsWith('/');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function uriEncode(value, encodeSlash = true) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  ).replace(/%2F/g, encodeSlash ? '%2F' : '/');
}

/**
 * Canonical request + signing key per SigV4 (single chunk, UNSIGNED-PAYLOAD
 * not needed since manifests are tiny — we hash the real body).
 */
function signRequest({ method, endpoint, bucket, key, region, credentials, payload, extraHeaders = {}, amzHeaders = {} }) {
  const pathStyle = endpoint.forcePathStyle !== false; // default true: widest compatibility
  const host = pathStyle
    ? `${endpoint.hostname}${endpoint.port === 443 || endpoint.port === 80 ? '' : `:${endpoint.port}`}`
    : undefined;
  // virtual-host style: bucket.host (only sensible for real AWS / R2 endpoints)
  const authority = pathStyle
    ? host
    : `${bucket}.${endpoint.hostname}${endpoint.port === 443 || endpoint.port === 80 ? '' : `:${endpoint.port}`}`;
  const canonicalUri = pathStyle ? `/${bucket}/${key.split('/').map(uriEncode).join('/')}` : `/${key.split('/').map(uriEncode).join('/')}`;

  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const headers = {
    host: authority,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...amzHeaders,
  };
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    '', // no query string in our calls
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    hostname: pathStyle ? endpoint.hostname : `${bucket}.${endpoint.hostname}`,
    port: endpoint.port,
    path: canonicalUri,
    method,
    headers: {
      ...extraHeaders,
      host: authority,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...amzHeaders,
      authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * Perform one signed request. Resolves { status, headers, body }.
 *
 * @param {object} p
 * @param {string} p.method
 * @param {ReturnType<typeof normalizeEndpoint> & {forcePathStyle?: boolean}} p.endpoint
 * @param {string} p.bucket
 * @param {string} p.key - full object key (prefix included)
 * @param {string} p.region
 * @param {{accessKeyId: string, secretAccessKey: string}} p.credentials
 * @param {Buffer|string} p.payload
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.timeoutMs]
 * @param {Record<string, string>} [p.amzHeaders]
 */
async function perform({ method, endpoint, bucket, key, region, credentials, payload, signal, timeoutMs = 30000, amzHeaders = {} }) {
  if (!validBucketName(bucket)) throw new S3Error(`invalid bucket name: ${bucket}`, 'config');
  if (endpoint.protocol === 'http:' && endpoint.allowInsecure !== true) {
    throw new S3Error('plain-http endpoint requires allowInsecure: true (traffic will be unencrypted)', 'config');
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const spec = signRequest({ method, endpoint, bucket, key, region, credentials, payload: body, amzHeaders });
  const transport = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new S3Error('S3 request timed out', 'timeout'));
    }, timeoutMs);
    const req = transport({
      hostname: spec.hostname,
      port: spec.port,
      path: spec.path,
      method: spec.method,
      headers: spec.headers,
      servername: spec.hostname,
      rejectUnauthorized: endpoint.rejectUnauthorized !== false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        req.destroy(new S3Error('S3 request aborted', 'timeout'));
      }, { once: true });
    }
    if (body.length > 0 || method === 'PUT') req.end(body);
    else req.end();
  });
}

/** Parse a MiniO/XML error body into a short message; S3 also emits these. */
function errorFrom(status, body, fallback) {
  const match = /<Message>([\s\S]*?)<\/Message>/.exec(body.toString('utf8'));
  const message = match ? match[1].trim() : fallback;
  if (status === 403) return new S3Error(message, 'auth', status);
  if (status === 404) return new S3Error(message, 'not-found', status);
  if (status === 409) return new S3Error(message, 'conflict', status);
  return new S3Error(message, `http-${status}`, status);
}

/** GET the manifest object. Throws S3Error code 'not-found' when absent. */
export async function s3Get(config, key, signal) {
  const endpoint = { ...normalizeEndpoint(config.endpoint), forcePathStyle: config.forcePathStyle !== false, allowInsecure: config.allowInsecure === true };
  const credentials = resolveCredentials(config);
  const result = await perform({ method: 'GET', endpoint, bucket: config.bucket, key, region: regionOf(config), credentials, payload: '', signal });
  if (result.status === 200) return result.body;
  if (result.status === 404) throw errorFrom(404, result.body, 'object not found');
  throw errorFrom(result.status, result.body, `GET failed with HTTP ${result.status}`);
}

/** HEAD the object; resolves { exists, etag, lastModified } without throwing on 404. */
export async function s3Head(config, key, signal) {
  const endpoint = { ...normalizeEndpoint(config.endpoint), forcePathStyle: config.forcePathStyle !== false, allowInsecure: config.allowInsecure === true };
  const credentials = resolveCredentials(config);
  const result = await perform({ method: 'HEAD', endpoint, bucket: config.bucket, key, region: regionOf(config), credentials, payload: '', signal });
  if (result.status === 200) {
    return { exists: true, etag: String(result.headers.etag ?? ''), lastModified: String(result.headers['last-modified'] ?? '') };
  }
  if (result.status === 404) return { exists: false, etag: '', lastModified: '' };
  throw errorFrom(result.status, result.body, `HEAD failed with HTTP ${result.status}`);
}

/**
 * PUT the object. Returns { etag }.
 * When `ifMatch` is supplied the request is conditional (optimistic lock).
 */
export async function s3Put(config, key, body, { signal, ifMatch, serverSideEncryption = false } = {}) {
  const endpoint = { ...normalizeEndpoint(config.endpoint), forcePathStyle: config.forcePathStyle !== false, allowInsecure: config.allowInsecure === true };
  const credentials = resolveCredentials(config);
  const amzHeaders = {};
  if (serverSideEncryption) amzHeaders['x-amz-server-side-encryption'] = 'AES256';
  if (ifMatch !== undefined && ifMatch !== '') amzHeaders['if-match'] = ifMatch;
  const result = await perform({ method: 'PUT', endpoint, bucket: config.bucket, key, region: regionOf(config), credentials, payload: body, signal, amzHeaders });
  if (result.status === 200 || result.status === 201) return { etag: String(result.headers.etag ?? '') };
  throw errorFrom(result.status, result.body, `PUT failed with HTTP ${result.status}`);
}

/** Region knob: AWS needs the real region; MinIO/RustFS accept anything (default 'auto'→us-east-1). */
function regionOf(config) {
  const region = typeof config.region === 'string' && config.region.trim() !== '' ? config.region.trim() : 'us-east-1';
  return region === 'auto' ? 'us-east-1' : region;
}

function resolveCredentials(config) {
  if (typeof config.accessKeyId === 'string' && config.accessKeyId !== ''
      && typeof config.secretAccessKey === 'string' && config.secretAccessKey !== '') {
    return { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  }
  const envKey = process.env.DSH_PLUGIN_SYNC_S3_KEY;
  const envSecret = process.env.DSH_PLUGIN_SYNC_S3_SECRET;
  if (envKey && envSecret) return { accessKeyId: envKey, secretAccessKey: envSecret };
  throw new S3Error('S3 credentials missing: set them in the plugin settings (credentials store) or DSH_PLUGIN_SYNC_S3_KEY/SECRET', 'auth');
}

/** The object key for one profile's manifest. */
export function manifestKey(config, profileName) {
  if (!validPrefix(config.prefix)) throw new S3Error('invalid prefix', 'config');
  const prefix = typeof config.prefix === 'string' && config.prefix !== '' ? `${config.prefix.replace(/\/+$/, '')}/` : '';
  const safeProfile = /^[A-Za-z0-9._-]+$/.test(profileName) ? profileName : null;
  if (safeProfile === null) throw new S3Error(`profile name cannot be used as an object key: ${profileName}`, 'config');
  return `${prefix}${safeProfile}.json`;
}
