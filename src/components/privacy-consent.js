import {
  grantRemoteProviderConsent,
  hasRemoteProviderConsent,
} from '../integrations/privacy.js';
import { closeModal, openModal } from './modal.js';
import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
} from '../data/operation-locks.js';
import { escapeHTML } from '../utils/sanitize.js';

export async function hasPrivacyConsent(key) {
  return hasRemoteProviderConsent(key);
}

export async function requestPrivacyConsent({
  key,
  title,
  message,
  confirmLabel = 'Continue',
}) {
  const mutationGeneration = captureDataMutationGeneration();
  const alreadyConsented = await hasPrivacyConsent(key);
  assertDataMutationGenerationCurrent(mutationGeneration);
  if (alreadyConsented) return true;

  return new Promise(resolve => {
    let settled = false;
    let saving = false;
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
      <p class="setting-hint" id="privacy-consent-error" role="alert" hidden></p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="privacy-cancel-btn">Use Local Data Only</button>
        <button class="btn btn-primary" id="privacy-confirm-btn">${escapeHTML(confirmLabel)}</button>
      </div>
    `;
    const dialog = openModal(modal, {
      canClose: () => !saving,
      onClose: () => finish(false),
    });
    const cancelButton = dialog.querySelector('#privacy-cancel-btn');
    const confirmButton = dialog.querySelector('#privacy-confirm-btn');
    const errorMessage = dialog.querySelector('#privacy-consent-error');
    cancelButton.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    confirmButton.addEventListener('click', async () => {
      saving = true;
      cancelButton.disabled = true;
      confirmButton.disabled = true;
      errorMessage.hidden = true;
      try {
        await grantRemoteProviderConsent(key, { mutationGeneration });
        finish(true);
        closeModal({ target: dialog, force: true, reason: 'completed' });
      } catch (error) {
        console.error('Could not save privacy consent:', error);
        saving = false;
        if (error?.code === 'DATA_OPERATION_INVALIDATED') {
          finish(false);
          closeModal({ target: dialog, force: true, reason: 'invalidated' });
          return;
        }
        if (!dialog.isConnected) {
          finish(false);
          return;
        }
        cancelButton.disabled = false;
        confirmButton.disabled = false;
        errorMessage.textContent = 'Could not save this permission. Please try again.';
        errorMessage.hidden = false;
        confirmButton.focus();
      }
    });
  });
}
