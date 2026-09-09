/**
 * modal.js — Modal / bottom sheet component
 */

let activeModal = null;
let modalSequence = 0;
let backgroundLock = null;

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container) {
    return [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(element => !element.hidden && element.getClientRects().length > 0);
}

function setBackgroundUnavailable(app) {
    if (!app) return;
    if (!backgroundLock) {
        backgroundLock = {
            app,
            inert: Boolean(app.inert),
            ariaHidden: app.getAttribute('aria-hidden'),
            bodyOverflow: document.body.style.overflow,
        };
    }
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = 'hidden';
}

function restoreBackground() {
    if (!backgroundLock) return;
    const { app, inert, ariaHidden, bodyOverflow } = backgroundLock;
    app.inert = inert;
    if (ariaHidden === null) app.removeAttribute('aria-hidden');
    else app.setAttribute('aria-hidden', ariaHidden);
    document.body.style.overflow = bodyOverflow;
    backgroundLock = null;
}

/**
 * Open a dialog. `canClose` may synchronously return false while a form is
 * dirty or a save is in progress. Route changes can still force-close it.
 */
export function openModal(content, { title = '', onClose = null, canClose = null } = {}) {
    closeModal({ force: true, immediate: true, restoreFocus: false, reason: 'replace' });
    const previouslyFocused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal({ reason: 'backdrop' });
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'modal-content';
    wrapper.tabIndex = -1;

    // Accept either a string or a DOM element
    if (typeof content === 'string') {
        // String mode: build header + body from HTML string
        wrapper.innerHTML = `
          <div class="modal-handle"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--sp-2)">
            ${title ? `<h2 class="modal-title" style="margin:0;flex:1">${title}</h2>` : '<div style="flex:1"></div>'}
            <button class="btn btn-ghost btn-icon modal-close-btn" style="flex-shrink:0" aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="modal-body">${content}</div>
        `;
        wrapper.querySelector('.modal-close-btn').addEventListener('click', () => closeModal({ reason: 'close-button' }));
    } else if (content instanceof HTMLElement) {
        // DOM element mode: the element already has its own header/close button
        // Strip modal-content class to avoid CSS conflict with the wrapper
        content.classList.remove('modal-content');
        // Move all children from the element into the wrapper
        while (content.firstChild) {
            wrapper.appendChild(content.firstChild);
        }
        // Copy over any extra classes (e.g. portion-editor, custom-food-form)
        for (const cls of content.classList) {
            wrapper.classList.add(cls);
        }
    }

    // ARIA dialog attributes
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    const modalTitle = wrapper.querySelector('h2');
    if (modalTitle) {
        const titleId = `modal-title-${Date.now()}-${++modalSequence}`;
        modalTitle.id = titleId;
        wrapper.setAttribute('aria-labelledby', titleId);
    } else {
        wrapper.setAttribute('aria-label', title || 'Dialog');
    }

    backdrop.appendChild(wrapper);
    document.body.appendChild(backdrop);
    wrapper.focus({ preventScroll: true });
    const app = document.getElementById('app');
    setBackgroundUnavailable(app);

    activeModal = {
        backdrop,
        content: wrapper,
        onClose,
        canClose,
        previouslyFocused,
    };

    // Focus the first focusable element in the modal
    setTimeout(() => {
        if (activeModal?.backdrop !== backdrop) return;
        // Do not steal focus after a user has already started interacting with
        // a control during the short entrance transition.
        if (document.activeElement !== wrapper) return;
        const focusable = getFocusableElements(wrapper);
        (focusable[0] || wrapper).focus();
    }, 50);

    // Escape key + focus trap
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal({ reason: 'escape' });
            return;
        }
        // Focus trap: Tab cycles within modal
        if (e.key === 'Tab') {
            const focusable = getFocusableElements(wrapper);
            if (focusable.length === 0) {
                e.preventDefault();
                wrapper.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!wrapper.contains(document.activeElement)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            } else if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };
    document.addEventListener('keydown', handleKeydown);
    activeModal.handleKeydown = handleKeydown;

    return wrapper;
}

export function closeModal({
    force = false,
    immediate = false,
    restoreFocus = true,
    reason = 'programmatic',
    target = null,
} = {}) {
    if (!activeModal) return false;
    if (target && activeModal.content !== target) return false;
    if (!force && typeof activeModal.canClose === 'function') {
        try {
            if (activeModal.canClose({ reason }) === false) {
                activeModal.content.focus();
                return false;
            }
        } catch (error) {
            console.warn('Modal close guard failed:', error);
            activeModal.content.focus();
            return false;
        }
    }

    const modal = activeModal;
    const {
        backdrop,
        content,
        onClose,
        handleKeydown,
        previouslyFocused,
    } = modal;
    document.removeEventListener('keydown', handleKeydown);
    activeModal = null;

    const finish = () => {
        backdrop.remove();
        if (!activeModal) {
            restoreBackground();
            if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
        }
        if (onClose) onClose({ reason });
    };

    if (immediate) {
        finish();
    } else {
        backdrop.style.opacity = '0';
        content.style.transform = 'translateY(16px)';
        backdrop.style.transition = 'opacity 150ms ease-out';
        setTimeout(finish, 150);
    }
    return true;
}

export function isModalOpen() {
    return activeModal !== null;
}
