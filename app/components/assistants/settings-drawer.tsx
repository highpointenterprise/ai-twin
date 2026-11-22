"use client";
import { useEffect, useRef, type ReactNode } from "react";
export function SettingsDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="assistant-drawer"
      ref={ref}
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="settings-title">{title} settings</h2>
        <button
          type="button"
          className="ghost"
          onClick={onClose}
          aria-label="Close settings"
        >
          ×
        </button>
      </header>
      <div className="drawer-content">{children}</div>
      <footer>
        <button type="button" onClick={onClose}>
          Done
        </button>
        <span>Changes stay in your draft until saved.</span>
      </footer>
    </dialog>
  );
}
