/**
 * toast.js — Toast notification system
 */

let container = null;

function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
    return container;
}

export function showToast(message, type = 'info', duration = 3000) {
    const c = ensureContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
    <span>${message}</span>
  `;
    c.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        toast.style.transition = 'all 200ms ease-out';
        setTimeout(() => toast.remove(), 200);
    }, duration);
}

export function showUndoToast(message, onUndo, duration = 5000) {
    const c = ensureContainer();
    const toast = document.createElement('div');
    toast.className = 'toast toast-info';

    const span = document.createElement('span');
    span.style.flex = '1';
    span.textContent = message;

    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-icon';
    btn.style.height = '32px';
    btn.style.width = '32px';
    btn.style.padding = '0';
    btn.style.marginLeft = 'auto';
    btn.style.flexShrink = '0';
    btn.textContent = 'Undo';
    btn.style.fontSize = 'var(--text-xs)';
    btn.style.padding = 'var(--sp-2) var(--sp-3)';
    btn.style.width = 'auto';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        toast.style.transition = 'all 200ms ease-out';
        setTimeout(() => toast.remove(), 200);
        if (onUndo) onUndo();
    });

    toast.appendChild(span);
    toast.appendChild(btn);
    c.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-8px)';
            toast.style.transition = 'all 200ms ease-out';
            setTimeout(() => toast.remove(), 200);
        }
    }, duration);
}
