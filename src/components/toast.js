/**
 * toast.js — Toast notification system
 */

let container = null;

function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(container);
    return container;
}

export function showToast(message, type = 'info', duration = 3000) {
    const c = ensureContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const isError = type === 'error';
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    toast.setAttribute('aria-atomic', 'true');
    const text = document.createElement('span');
    text.textContent = String(message ?? '');
    toast.appendChild(text);
    c.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        toast.style.transition = 'all 200ms ease-out';
        setTimeout(() => toast.remove(), 200);
    }, isError ? Math.max(duration, 6000) : duration);
}

export function showUndoToast(message, onUndo, duration = 5000) {
    const c = ensureContainer();
    const toast = document.createElement('div');
    toast.className = 'toast toast-info';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');

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
        if (onUndo) Promise.resolve(onUndo()).catch(() => {
            showToast('Undo could not be completed', 'error');
        });
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
