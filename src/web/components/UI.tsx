import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? "brand-mark small-mark" : "brand-mark"}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 12v8M11 7v18M16 3v26M21 9v14M26 12v8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
const icon = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
export const FolderIcon = () => (
  <svg className="icon" {...icon}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" />
  </svg>
);
export const FolderPlusIcon = () => (
  <svg className="icon" {...icon}>
    <path d="M12 19H5.5A2.5 2.5 0 0 1 3 16.5v-9A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v2.5M18 15v6M15 18h6" />
  </svg>
);
export function Button({
  children,
  variant = "",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Loading({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-label={label}>
      <div className="skeleton skeleton-title" />
      <div className="skeleton" />
      <div className="skeleton" />
      <span className="sr-only">{label}…</span>
    </div>
  );
}
export function Notice({
  children,
  kind = "error",
  retry,
}: {
  children: ReactNode;
  kind?: "error" | "success" | "warn";
  retry?: () => void;
}) {
  return (
    <div
      className={`alert ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      <div>{children}</div>
      {retry && (
        <Button variant="small ghost" onClick={retry}>
          Try again ↻
        </Button>
      )}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">
        <Mark />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Connection({
  state,
}: {
  state: "connecting" | "connected" | "reconnecting";
}) {
  return (
    <span className={`connection ${state}`} role="status">
      <i />
      {state === "connected"
        ? "Live updates"
        : state === "connecting"
          ? "Connecting…"
          : "Reconnecting · refreshes every 10s"}
    </span>
  );
}
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (status) {
      const timer = setTimeout(() => setStatus(""), 2500);
      return () => clearTimeout(timer);
    }
  }, [status]);
  return (
    <Button
      variant="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied");
        } catch {
          setStatus("Select text to copy");
        }
      }}
    >
      <span role="status">{status || label}</span>
    </Button>
  );
}
/** A modal dialog: a side panel by default, or a centered card. */
export function Drawer({
  title,
  eyebrow = "Your team",
  closeLabel = "Close editor",
  layout = "drawer",
  children,
  onClose,
  busy,
}: {
  title: string;
  eyebrow?: string | null;
  closeLabel?: string;
  layout?: "drawer" | "modal";
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={layout === "modal" ? "drawer modal" : "drawer"}
      aria-labelledby="drawer-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="drawer-inner">
        <div className="drawer-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id="drawer-title">{title}</h2>
          </div>
          <Button
            variant="icon ghost"
            aria-label={closeLabel}
            disabled={busy}
            onClick={onClose}
          >
            ×
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
