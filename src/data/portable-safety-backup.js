/**
 * A join safety backup must leave the browser profile as a portable artifact.
 * Automatic rolling snapshots intentionally remain a separate recovery system.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import {
  exportAllData,
  setSetting,
  validateBackupData,
} from './db.js';

const JSON_TYPE = 'application/json';

function safetyBackupFilename(date) {
  return `librelog-before-sync-${date.toISOString().replace(/[:.]/g, '-')}.json`;
}

async function persistNativeArtifact({ filename, serialized }) {
  await Filesystem.writeFile({
    path: filename,
    data: serialized,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
  const saved = await Filesystem.readFile({
    path: filename,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
  return { method: 'native-documents', readback: saved.data };
}

async function persistWithFilePicker({ filename, blob }) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [{
      description: 'LibreLog portable backup',
      accept: { [JSON_TYPE]: ['.json'] },
    }],
  });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw error;
  }
  const saved = await handle.getFile();
  return { method: 'file-picker', readback: await saved.text() };
}

async function persistBrowserDownload({ filename, blob }) {
  if (typeof document === 'undefined' || !document.body || typeof URL?.createObjectURL !== 'function') {
    throw new Error('A portable backup cannot be saved in this environment');
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }

  // A normal browser download does not expose its destination. Require the
  // user to select the saved file once, so a blocked/truncated/canceled
  // download can never be reported as a verified pre-join checkpoint.
  const readback = await new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.hidden = true;
    document.body.appendChild(input);
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      input.remove();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Select the downloaded portable backup to verify it before joining'));
    };
    const onFocus = () => {
      setTimeout(() => {
        if (!settled && input.files?.length === 0) fail();
      }, 500);
    };
    input.addEventListener('change', async () => {
      if (!input.files?.[0]) {
        fail();
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const text = await input.files[0].text();
        resolve(text);
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    input.addEventListener('cancel', fail, { once: true });
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
  return { method: 'verified-browser-download', readback };
}

async function persistPortableArtifact(artifact) {
  if (Capacitor.isNativePlatform()) return persistNativeArtifact(artifact);
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    return persistWithFilePicker(artifact);
  }
  return persistBrowserDownload(artifact);
}

/**
 * Create, save, read back, and validate a credential-free portable backup.
 * Any cancellation, write failure, or mismatch rejects so LibreSync pairing
 * cannot consume its single-use invitation without a recoverable checkpoint.
 */
export async function createPortableSafetyBackup({
  clock = () => new Date(),
  persistArtifact = persistPortableArtifact,
} = {}) {
  const data = await exportAllData();
  validateBackupData(data);
  const serialized = JSON.stringify(data, null, 2);
  const blob = new Blob([serialized], { type: JSON_TYPE });

  // Validate the generated portable bytes before handing them to a filesystem
  // or download manager, then validate the persisted/read-back bytes again.
  const generatedReadback = await blob.text();
  if (generatedReadback !== serialized) {
    throw new Error('Portable safety backup generation could not be verified');
  }
  validateBackupData(JSON.parse(generatedReadback));

  const filename = safetyBackupFilename(clock());
  const saved = await persistArtifact({ data, filename, serialized, blob });
  if (!saved || saved.readback !== serialized) {
    throw new Error('Portable safety backup write could not be verified');
  }
  validateBackupData(JSON.parse(saved.readback));
  await setSetting('lastPortableBackupTime', Date.now());

  return {
    verified: true,
    filename,
    method: saved.method || 'portable-file',
  };
}
