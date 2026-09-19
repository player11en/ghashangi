// Local files: the file picker, drag-and-drop, and folder drops.
//
// B8 dies here. The original read every dropped file with
// FileReader.readAsDataURL, producing a base64 data URL ~33% larger than the
// file, then converted it back with atob() and a per-byte charCodeAt loop:
//
//     const bytes = new Uint8Array(len);
//     for (let i = 0; i < len; ++i) bytes[i] = binary.charCodeAt(i);
//     return new Blob([bytes], { type });
//
// Three full copies of the file in memory, one of them a JS string, built one
// byte at a time on the main thread — to arrive at a Blob, which the File
// already was. URL.createObjectURL(file) does the whole thing for free, with no
// copy at all. For the 4.4MB demo model that is tens of megabytes of garbage
// saved; for a large scan it is the difference between loading and hanging.

/**
 * Recursively collect files from a dropped directory entry.
 *
 * createReader().readEntries() is paginated and returns at most ~100 entries per
 * call, so it has to be drained in a loop. Reading it once — the obvious
 * implementation — silently truncates large folders.
 *
 * @param {FileSystemDirectoryEntry} entry
 * @returns {Promise<File[]>}
 */
async function readDirectory(entry) {
  const reader = entry.createReader();
  const out = [];

  const readBatch = () =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

  for (;;) {
    const batch = await readBatch();
    if (batch.length === 0) break;
    for (const child of batch) {
      out.push(...(await readEntry(child)));
    }
  }

  return out;
}

/** @returns {Promise<File[]>} */
async function readEntry(entry) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    // Preserve the path so sibling references inside a folder still resolve.
    if (!file.webkitRelativePath && entry.fullPath) {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: entry.fullPath.replace(/^\//, ''),
        configurable: true,
      });
    }
    return [file];
  }
  if (entry.isDirectory) return readDirectory(entry);
  return [];
}

/**
 * Extract every file from a drop, expanding any dropped folders.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<File[]>}
 */
export async function filesFromDrop(dataTransfer) {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];

  // webkitGetAsEntry is what makes folder drops possible. It is non-standard but
  // supported everywhere that matters; the plain files list is the fallback.
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length === 0) {
    return Array.from(dataTransfer.files ?? []);
  }

  const nested = await Promise.all(entries.map(readEntry));
  return nested.flat();
}

/**
 * Wire up the file picker and page-wide drag-and-drop.
 *
 * @param {object} options
 * @param {HTMLInputElement} options.input
 * @param {HTMLElement} options.openButton
 * @param {HTMLElement} options.overlay     Shown while a drag is over the page.
 * @param {(files: File[]) => void} options.onFiles
 * @param {(error: Error) => void} [options.onError]
 */
export function createFileSource({ input, openButton, overlay, onFiles, onError }) {
  openButton.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    if (files.length > 0) onFiles(files);
    // Reset so selecting the same file twice in a row fires again.
    input.value = '';
  });

  // dragenter/dragleave fire for every element the pointer crosses, so a plain
  // boolean flickers the overlay. Counting them does not.
  let dragDepth = 0;

  function showOverlay(show) {
    overlay.hidden = !show;
  }

  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    showOverlay(true);
  });

  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    // Without preventDefault the browser navigates to the dropped file.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showOverlay(false);
  });

  window.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth = 0;
    showOverlay(false);

    try {
      const files = await filesFromDrop(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
