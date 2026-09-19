// Loading a model from a URL, with real progress.
//
// Uses fetch + a stream reader rather than handing the URL straight to three's
// loaders, for three reasons:
//
//   - Progress. Content-Length is readable here, so the bar is a real
//     percentage instead of the indeterminate crawl three's onProgress gives
//     for a cross-origin response.
//   - Error quality. A 403 or 404 can be turned into a sentence about sharing
//     settings; three's loaders surface only "failed to load".
//   - Cancellation. An AbortController lets a second paste cancel the first
//     download instead of racing it.
//
// The result is a Blob, which becomes an object URL, which every loader already
// knows how to open — so nothing downstream needs a remote-specific path.

/** Rewrite common share links into their direct-download equivalents. */
export function normalizeUrl(input) {
  const raw = input.trim();

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidUrlError(raw);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(raw, 'Only http and https links are supported.');
  }

  // Dropbox: the share link serves an HTML preview page, not the file.
  if (url.hostname.endsWith('dropbox.com')) {
    url.hostname = 'dl.dropboxusercontent.com';
    url.searchParams.delete('dl');
    url.searchParams.delete('raw');
    return { url: url.toString(), source: 'dropbox' };
  }

  // GitHub blob pages are HTML; raw.githubusercontent.com serves the bytes.
  if (url.hostname === 'github.com' && url.pathname.includes('/blob/')) {
    return {
      url: `https://raw.githubusercontent.com${url.pathname.replace('/blob/', '/')}`,
      source: 'github',
    };
  }

  return { url: url.toString(), source: 'direct' };
}

/** Best-effort filename for a URL, used to pick the loader. */
export function filenameFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const name = decodeURIComponent(pathname.split('/').pop() ?? '');
    return name || 'model';
  } catch {
    return 'model';
  }
}

/**
 * Download a URL as a Blob, reporting progress.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {(fraction:number|null, loaded:number, total:number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {Record<string,string>} [options.headers]
 * @returns {Promise<Blob>}
 */
export async function fetchAsBlob(url, { onProgress, signal, headers } = {}) {
  let response;
  try {
    response = await fetch(url, { signal, headers, mode: 'cors', redirect: 'follow' });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // fetch() rejects with an opaque TypeError for CORS failures, DNS failures
    // and offline alike, so this cannot be narrowed further from here.
    throw new RemoteFetchError(
      'The server could not be reached, or it does not allow cross-origin requests.',
      { url, cause: error },
    );
  }

  if (!response.ok) {
    throw new RemoteFetchError(describeHttpStatus(response.status), {
      url,
      status: response.status,
    });
  }

  const total = Number(response.headers.get('content-length')) || 0;

  // No body reader (or no length): fall back to a plain blob() and an
  // indeterminate bar rather than failing.
  if (!response.body || !total) {
    onProgress?.(null, 0, 0);
    return response.blob();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded / total, loaded, total);
  }

  return new Blob(chunks, {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  });
}

function describeHttpStatus(status) {
  if (status === 401 || status === 403) {
    return 'Access denied (HTTP ' + status + '). The file may be private.';
  }
  if (status === 404) return 'Not found (HTTP 404). Check the link.';
  if (status === 429) return 'Rate limited (HTTP 429). Try again shortly.';
  if (status >= 500) return `The server returned an error (HTTP ${status}).`;
  return `The request failed (HTTP ${status}).`;
}

export class InvalidUrlError extends Error {
  constructor(input, detail = 'That does not look like a URL.') {
    super(detail);
    this.name = 'InvalidUrlError';
    this.input = input;
  }
}

export class RemoteFetchError extends Error {
  constructor(message, { url, status, cause } = {}) {
    super(message, { cause });
    this.name = 'RemoteFetchError';
    this.url = url;
    this.status = status;
  }
}
