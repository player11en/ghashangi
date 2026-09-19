// Loading a model from a Google Drive share link.
//
// Only one browser-reachable route into Drive exists without OAuth:
//
//   https://www.googleapis.com/drive/v3/files/{id}?alt=media&key={KEY}
//
// It reflects the request Origin in Access-Control-Allow-Origin and exposes
// Content-Length, so it can be fetched from a page and shows real progress.
//
// The link people actually paste — https://drive.google.com/uc?export=download
// — answers 403 with no CORS headers at all and cannot be used from a browser
// under any circumstances. It is a common suggestion and a dead end; do not
// reintroduce it.
//
// This route reads files shared as "Anyone with the link" only. Private files
// need OAuth and the Google Picker, which is not implemented — createDriveSource
// is shaped so that can be added as a second strategy without touching callers.
//
// On the API key: Vite inlines VITE_GOOGLE_API_KEY into the bundle, so it is
// public in any deployment and cannot be hidden. The protection is restricting
// it in Google Cloud Console to the Drive API and to your deployment's HTTP
// referrers — see .env.example. Absent a key, the Drive input is hidden and
// file/URL loading is unaffected.

import { fetchAsBlob, RemoteFetchError } from './url.js';

const API_BASE = 'https://www.googleapis.com/drive/v3/files';

/** Drive file ids are 25-44 chars of base64url-ish alphabet. */
const ID_PATTERN = '[A-Za-z0-9_-]{25,44}';

/**
 * Extract a Drive file id from any of the link shapes Google hands out.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function parseDriveId(input) {
  const raw = input.trim();
  if (!raw) return null;

  // A bare id pasted on its own.
  if (new RegExp(`^${ID_PATTERN}$`).test(raw)) return raw;

  const patterns = [
    new RegExp(`/file/d/(${ID_PATTERN})`),      // /file/d/{id}/view
    new RegExp(`/document/d/(${ID_PATTERN})`),  // Docs-style
    new RegExp(`/d/(${ID_PATTERN})`),           // short /d/{id}
    new RegExp(`[?&]id=(${ID_PATTERN})`),       // ?id={id}, /open?id={id}, /uc?id={id}
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/** True when the input looks like it was meant to be a Drive link at all. */
export function looksLikeDriveLink(input) {
  return /drive\.google\.com|docs\.google\.com/.test(input) || parseDriveId(input) !== null;
}

export function isDriveConfigured() {
  return Boolean(import.meta.env.VITE_GOOGLE_API_KEY);
}

/**
 * Turn a Drive API error body into something actionable.
 * @param {Response|null} response
 * @param {any} body Parsed JSON error payload, if there was one.
 */
function describeDriveError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason ?? '';
  const message = body?.error?.message ?? '';

  if (reason === 'keyInvalid' || /API key not valid/i.test(message)) {
    return 'This deployment\'s Google API key is not valid. Check VITE_GOOGLE_API_KEY and that the Drive API is enabled for it.';
  }
  if (reason === 'ipRefererBlocked' || /referer/i.test(message)) {
    return 'The Google API key does not allow requests from this site. Add this origin to the key\'s HTTP referrer restrictions in Google Cloud Console.';
  }
  if (status === 403) {
    return 'Drive refused access. Open the file in Drive, choose Share, and set General access to "Anyone with the link".';
  }
  if (status === 404) {
    return 'No such file, or it is not shared. Set the file\'s General access to "Anyone with the link".';
  }
  if (status === 401) {
    return 'Drive requires sign-in for this file. Only files shared as "Anyone with the link" can be opened here.';
  }
  return message || `Drive returned HTTP ${status}.`;
}

/**
 * Read a file's metadata: its real name (which determines the loader) and size
 * (so the UI can warn before starting a very large download).
 *
 * @param {string} id
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<{name: string, size: number, mimeType: string}>}
 */
export async function fetchDriveMetadata(id, apiKey, signal) {
  const url = `${API_BASE}/${encodeURIComponent(id)}?fields=name,size,mimeType&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, { signal, mode: 'cors' });
  let body = null;
  try {
    body = await response.clone().json();
  } catch {
    // Non-JSON error page; describeDriveError falls back to the status.
  }

  if (!response.ok) {
    throw new RemoteFetchError(describeDriveError(response.status, body), {
      url,
      status: response.status,
    });
  }

  return {
    name: body?.name ?? 'model',
    size: Number(body?.size) || 0,
    mimeType: body?.mimeType ?? '',
  };
}

/**
 * Download a Drive file.
 *
 * @param {string} input     Any Drive link shape, or a bare file id.
 * @param {object} [options]
 * @param {(fraction:number|null, loaded:number, total:number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{blob: Blob, name: string, size: number}>}
 */
export async function fetchFromDrive(input, { onProgress, signal } = {}) {
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
  if (!apiKey) {
    throw new RemoteFetchError(
      'Google Drive support is not configured on this deployment. Set VITE_GOOGLE_API_KEY (see .env.example).',
      { url: input },
    );
  }

  const id = parseDriveId(input);
  if (!id) {
    throw new RemoteFetchError(
      'No Drive file id found in that link. Use the "Copy link" option in Drive — it looks like https://drive.google.com/file/d/FILE_ID/view.',
      { url: input },
    );
  }

  // Metadata first: the filename decides which loader runs, and Drive's media
  // response carries a generic content type that cannot be relied on for that.
  const meta = await fetchDriveMetadata(id, apiKey, signal);

  const mediaUrl = `${API_BASE}/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(apiKey)}`;

  try {
    const blob = await fetchAsBlob(mediaUrl, { onProgress, signal });
    return { blob, name: meta.name, size: meta.size || blob.size };
  } catch (error) {
    // fetchAsBlob describes generic HTTP failures; re-describe with Drive's
    // vocabulary where the status warrants it.
    if (error instanceof RemoteFetchError && error.status) {
      throw new RemoteFetchError(describeDriveError(error.status, null), {
        url: mediaUrl,
        status: error.status,
      });
    }
    throw error;
  }
}
