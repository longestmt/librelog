import { getSetting, setSetting } from '../data/db.js';
import { closeModal, openModal } from './modal.js';
import { escapeHTML } from '../utils/sanitize.js';

export async function hasPrivacyConsent(key) {
  return Boolean(await getSetting(`privacyConsent_${key}`, false));
}

export async function requestPrivacyConsent({
  key,
  title,
  message,
  confirmLabel = 'Continue',
}) {
  if (await hasPrivacyConsent(key)) return true;

  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header"><h2>${escapeHTML(title)}</h2></div>
      <p class="confirm-message">${escapeHTML(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="privacy-cancel-btn">Use Local Data Only</button>
        <button class="btn btn-primary" id="privacy-confirm-btn">${escapeHTML(confirmLabel)}</button>
      </div>
    `;
    openModal(modal, { onClose: () => finish(false) });
    document.getElementById('privacy-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('privacy-confirm-btn').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      await setSetting(`privacyConsent_${key}`, true);
      finish(true);
      closeModal();
    });
  });
}
