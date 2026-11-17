import '@testing-library/jest-dom/vitest';

// jsdom lacks dialog lifecycle methods; native focus and dismissal are checked in a browser.
Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.open = true;
  },
  close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  },
});
