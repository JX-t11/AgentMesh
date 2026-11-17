import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface DialogProps {
  label: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  wide?: boolean;
  className?: string;
}

export function Dialog({ label, onClose, children, drawer = false, wide = false, className = '' }: DialogProps) {
  const panelRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current!;
    const needsLightDismissFallback = !('closedBy' in HTMLDialogElement.prototype);
    let pressedOutside = false;
    const handlePointerDown = (event: PointerEvent) => {
      pressedOutside = isOutsideDialog(event, panel);
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (pressedOutside && isOutsideDialog(event, panel)) panel.close();
      pressedOutside = false;
    };
    if (needsLightDismissFallback) {
      panel.addEventListener('pointerdown', handlePointerDown);
      panel.addEventListener('pointerup', handlePointerUp);
    }
    panel.showModal();
    return () => {
      panel.removeEventListener('pointerdown', handlePointerDown);
      panel.removeEventListener('pointerup', handlePointerUp);
      panel.close();
    };
  }, []);

  return createPortal(
    <dialog
      ref={panelRef}
      className={`${drawer ? `overlay-drawer ${wide ? 'wide' : ''}` : 'modal-card'} ${className}`}
      aria-label={label}
      closedby="any"
      onClose={(event) => {
        // StrictMode can reopen the dialog before a queued close event is delivered.
        if (!event.currentTarget.open) onClose();
      }}
    >
      {children}
    </dialog>,
    document.body,
  );
}

function isOutsideDialog(event: PointerEvent, panel: HTMLDialogElement): boolean {
  const rect = panel.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right ||
    event.clientY < rect.top || event.clientY > rect.bottom;
}
