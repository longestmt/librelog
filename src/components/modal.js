/**
 * modal.js — Modal / bottom sheet component
 */

let activeModal = null;

export function openModal(content, { title = '', onClose = null } = {}) {
    closeModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal();
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'modal-content';

    // Accept either a string or a DOM element
    if (typeof content === 'string') {
        // String mode: build header + body from HTML string
        wrapper.innerHTML = `
          <div class="modal-handle"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--sp-2)">
            ${title ? `<h2 class="modal-title" style="margin:0;flex:1">${title}</h2>` : '<div style="flex:1"></div>'}
            <button class="btn btn-ghost btn-icon modal-close-btn" style="width:32px;height:32px;flex-shrink:0" title="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="modal-body">${content}</div>
        `;
        wrapper.querySelector('.modal-close-btn').addEventListener('click', () => closeModal());
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
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    const modalTitle = wrapper.querySelector('h2');
    if (modalTitle) {
        const titleId = 'modal-title-' + Date.now();
        modalTitle.id = titleId;
        backdrop.setAttribute('aria-labelledby', titleId);
    }

    backdrop.appendChild(wrapper);
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    activeModal = { backdrop, content: wrapper, onClose };

    // Focus the first focusable element in the modal
    const focusable = wrapper.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length > 0) {
        setTimeout(() => focusable[0].focus(), 50);
    }

    // Escape key + focus trap
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            return;
        }
        // Focus trap: Tab cycles within modal
        if (e.key === 'Tab' && focusable.length > 0) {
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
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

export function closeModal() {
    if (!activeModal) return;
    const { backdrop, onClose, handleKeydown } = activeModal;
    document.removeEventListener('keydown', handleKeydown);
    backdrop.style.opacity = '0';
    backdrop.querySelector('.modal-content').style.transform = 'translateY(16px)';
    backdrop.style.transition = 'opacity 150ms ease-out';
    setTimeout(() => {
        backdrop.remove();
        document.body.style.overflow = '';
        if (onClose) onClose();
    }, 150);
    activeModal = null;
}

export function isModalOpen() {
    return activeModal !== null;
}
